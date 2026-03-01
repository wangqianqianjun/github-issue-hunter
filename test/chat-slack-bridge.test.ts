import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import {
  buildSocketEventDedupKey,
  extractSocketModeInboundMessage,
  isHumanSocketModeEvent,
  isStopCommand,
  loadThreadSubscriptions,
  normalizePostedSlackThreadId,
  persistThreadSubscriptions,
  resolveThreadSubscriptionFile
} from "../src/chat/vercel-chat-bridge.js";

describe("ChatSlackBridge helpers", () => {
  it("normalizes chat-sdk channel post result into a concrete slack thread id", () => {
    const threadId = normalizePostedSlackThreadId("C12345", "slack:C12345:", "1744971837.356529");
    expect(threadId).toBe("slack:C12345:1744971837.356529");
  });

  it("keeps a concrete thread id unchanged", () => {
    const threadId = normalizePostedSlackThreadId("C12345", "slack:C12345:1744971837.356529", "1744971837.356529");
    expect(threadId).toBe("slack:C12345:1744971837.356529");
  });

  it("detects stop wording in Chinese and English", () => {
    expect(isStopCommand("停止")).toBe(true);
    expect(isStopCommand("请 stop 当前任务")).toBe(true);
    expect(isStopCommand("cancel now")).toBe(true);
    expect(isStopCommand("status")).toBe(false);
  });

  it("persists and reloads concrete slack thread subscriptions", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-chat-"));
    try {
      const filePath = join(root, "runtime", "chat-thread-subscriptions.json");
      await persistThreadSubscriptions(filePath, [
        "",
        "slack:C12345:",
        "slack:C12345:1744971837.356529",
        "slack:C12345:1744971837.356529",
        "slack:C67890:1744972000.000001"
      ]);

      const stored = JSON.parse(await readFile(filePath, "utf8")) as { threads?: string[] };
      expect(stored.threads).toEqual([
        "slack:C12345:1744971837.356529",
        "slack:C67890:1744972000.000001"
      ]);

      const loaded = await loadThreadSubscriptions(filePath);
      expect(loaded).toEqual([
        "slack:C12345:1744971837.356529",
        "slack:C67890:1744972000.000001"
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("resolves subscription file path under runtime alongside config", () => {
    const path = resolveThreadSubscriptionFile("/tmp/issue-hunter/config/app-config.json");
    expect(path).toBe(resolve("/tmp/issue-hunter/config/runtime/chat-thread-subscriptions.json"));
  });

  it("extracts socket-mode thread message for normal channel reply", () => {
    const message = extractSocketModeInboundMessage({
      type: "message",
      user: "U123",
      channel: "C777",
      thread_ts: "1772222222.111111",
      text: "继续处理一下"
    });
    expect(message).toEqual({
      threadId: "slack:C777:1772222222.111111",
      channelId: "C777",
      text: "继续处理一下",
      isMention: false
    });
  });

  it("extracts socket-mode app_mention and falls back to ts when thread_ts missing", () => {
    const message = extractSocketModeInboundMessage({
      type: "app_mention",
      user: "U123",
      channel: "C777",
      ts: "1772222333.222222",
      text: "<@U999> status"
    });
    expect(message).toEqual({
      threadId: "slack:C777:1772222333.222222",
      channelId: "C777",
      text: "<@U999> status",
      isMention: true
    });
  });

  it("extracts message_replied subtype by reading nested message payload", () => {
    const message = extractSocketModeInboundMessage({
      type: "message",
      subtype: "message_replied",
      channel: "C888",
      ts: "1773000000.000001",
      message: {
        type: "message",
        user: "U777",
        text: "我在 thread 里回复一下",
        thread_ts: "1772999999.999999",
        ts: "1773000000.000001"
      }
    });
    expect(message).toEqual({
      threadId: "slack:C888:1772999999.999999",
      channelId: "C888",
      text: "我在 thread 里回复一下",
      isMention: false
    });
  });

  it("ignores socket-mode bot/subtype/update style events", () => {
    expect(
      extractSocketModeInboundMessage({
        type: "message",
        channel: "C777",
        user: "U123",
        ts: "177",
        text: "edited",
        subtype: "message_changed"
      })
    ).toBeNull();
    expect(
      extractSocketModeInboundMessage({
        type: "message",
        channel: "C777",
        ts: "177",
        text: "bot"
      })
    ).toBeNull();
  });

  it("accepts only human socket-mode messages with client_msg_id", () => {
    expect(
      isHumanSocketModeEvent({
        type: "message",
        user: "U123",
        channel: "C777",
        thread_ts: "1772222222.111111",
        text: "继续处理",
        client_msg_id: "7f4f6d8d-1f2e-4d0c-9f8a-e3f4b5a6c7d8"
      })
    ).toBe(true);

    expect(
      isHumanSocketModeEvent({
        type: "message",
        user: "U123",
        channel: "C777",
        thread_ts: "1772222222.111111",
        text: "bot echo",
        bot_id: "B999"
      })
    ).toBe(false);

    expect(
      isHumanSocketModeEvent({
        type: "message",
        user: "U123",
        channel: "C777",
        thread_ts: "1772222222.111111",
        text: "no client msg id"
      })
    ).toBe(false);
  });

  it("accepts message_replied only when nested client_msg_id exists", () => {
    expect(
      isHumanSocketModeEvent({
        type: "message",
        subtype: "message_replied",
        channel: "C888",
        message: {
          user: "U777",
          thread_ts: "1772999999.999999",
          text: "我在 thread 里回复",
          client_msg_id: "9f4f6d8d-1f2e-4d0c-9f8a-e3f4b5a6c7d8"
        }
      })
    ).toBe(true);

    expect(
      isHumanSocketModeEvent({
        type: "message",
        subtype: "message_replied",
        channel: "C888",
        message: {
          user: "U777",
          thread_ts: "1772999999.999999",
          text: "我在 thread 里回复"
        }
      })
    ).toBe(false);
  });

  it("builds stable dedup key from envelope id when present", () => {
    const key = buildSocketEventDedupKey({
      envelopeId: "abc-123",
      event: {
        type: "message",
        channel: "C1",
        user: "U1",
        ts: "1.1",
        text: "hello"
      }
    });
    expect(key).toBe("envelope:abc-123");
  });
});
