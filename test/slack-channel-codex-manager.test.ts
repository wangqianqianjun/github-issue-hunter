import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { SlackChannelCodexManager } from "../src/core/slack-channel-codex-manager.js";
import type { AppConfig, RepositoryConfig } from "../src/types/config.js";

function makeRepo(localPath: string): RepositoryConfig {
  return {
    id: "acme-web",
    owner: "acme",
    repo: "web",
    localPath,
    triageCommand: "triage",
    implementCommand: "implement",
    triageWording: "已经收到，正在分析",
    implementWording: "已经确认，正在处理",
    ignoreWording: "已经确认，目前没有计划支持",
    enabled: true,
    perRepoConcurrency: 1,
    slack: {
      enabled: true,
      channelId: "C123",
      transport: "chat_sdk"
    }
  };
}

function makeConfig(repo: RepositoryConfig): AppConfig {
  return {
    repositories: [repo],
    global: {
      pollIntervalSeconds: 30,
      globalConcurrency: 1,
      workspaceDir: ".",
      closeIssueOnDone: false,
      keepWorktrees: true,
      planMode: false
    },
    slackApp: {
      enabled: true,
      botToken: "",
      appToken: "",
      signingSecret: "",
      clientId: "",
      clientSecret: "",
      botTokenEnv: "SLACK_BOT_TOKEN",
      signingSecretEnv: "SLACK_SIGNING_SECRET",
      appTokenEnv: "SLACK_APP_TOKEN",
      clientIdEnv: "SLACK_CLIENT_ID",
      clientSecretEnv: "SLACK_CLIENT_SECRET",
      webhookBaseUrl: "",
      appDisplayName: "Issue Hunter",
      botDisplayName: "Issue Hunter Bot",
      useSocketMode: true
    },
    serviceState: {
      running: true,
      lastRunAt: "",
      lastError: "",
      activeTasks: 0
    }
  };
}

describe("SlackChannelCodexManager", () => {
  it("ignores messages when channel has no bound repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-"));
    try {
      const repoRoot = join(root, "repo");
      await mkdir(repoRoot, { recursive: true });
      const repo = makeRepo(repoRoot);
      const config = makeConfig(repo);
      const configStore = {
        load: async () => ({
          ...config,
          repositories: [{ ...repo, slack: { ...repo.slack, channelId: "C999" } }]
        })
      };

      const manager = new SlackChannelCodexManager(
        configStore as never,
        join(root, "runtime", "sessions.json")
      );
      const result = await manager.handleMessage({
        threadId: "slack:C123:1.0",
        channelId: "C123",
        text: "hello",
        isMention: false,
        post: async () => undefined
      });
      expect(result.accepted).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes channel message to codex thread session for bound repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-"));
    const prevBin = process.env.ISSUE_HUNTER_CODEX_BIN;
    process.env.ISSUE_HUNTER_CODEX_BIN = "true";
    try {
      const repoRoot = join(root, "repo");
      await mkdir(repoRoot, { recursive: true });
      const repo = makeRepo(repoRoot);
      const config = makeConfig(repo);
      const configStore = {
        load: async () => config
      };

      const runner = async (command: string, args: string[]) => {
        if (command === "git" && args.includes("worktree") && args.includes("add")) {
          const target = args[args.length - 2];
          await mkdir(target, { recursive: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      const manager = new SlackChannelCodexManager(
        configStore as never,
        join(root, "runtime", "sessions.json"),
        runner as never
      );

      const posts: string[] = [];
      const result = await manager.handleMessage({
        threadId: "slack:C123:2.0",
        channelId: "C123",
        text: "please implement",
        isMention: false,
        post: async (text) => {
          posts.push(text);
        }
      });
      expect(result.accepted).toBe(true);
      expect(result.message).toContain("开始在仓库");

      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(posts.some((item) => item.includes("未捕获可展示输出") || item.includes("处理失败"))).toBe(true);
    } finally {
      if (prevBin === undefined) {
        delete process.env.ISSUE_HUNTER_CODEX_BIN;
      } else {
        process.env.ISSUE_HUNTER_CODEX_BIN = prevBin;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses issue-thread hints to reuse codex session without channel binding lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-hint-"));
    const prevBin = process.env.ISSUE_HUNTER_CODEX_BIN;
    process.env.ISSUE_HUNTER_CODEX_BIN = "true";
    try {
      const repoRoot = join(root, "repo");
      await mkdir(repoRoot, { recursive: true });
      const repo = makeRepo(repoRoot);
      const config = makeConfig(repo);
      const configStore = {
        load: async () => ({
          ...config,
          repositories: [{ ...repo, slack: { ...repo.slack, channelId: "C999" } }]
        })
      };

      const runner = async (command: string, args: string[]) => {
        if (command === "git" && args.includes("worktree") && args.includes("add")) {
          const target = args[args.length - 2];
          await mkdir(target, { recursive: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      const sessionsFile = join(root, "runtime", "sessions.json");
      const manager = new SlackChannelCodexManager(
        configStore as never,
        sessionsFile,
        runner as never
      );

      const result = await manager.handleMessage({
        threadId: "slack:C123:22.0",
        channelId: "C123",
        text: "继续按上次上下文处理",
        isMention: false,
        repoIdHint: repo.id,
        codexSessionIdHint: "session-from-issue-record",
        post: async () => undefined
      });
      expect(result.accepted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 60));

      const persisted = JSON.parse(await readFile(sessionsFile, "utf8")) as {
        sessions?: Array<{ threadId?: string; codexSessionId?: string }>;
      };
      const target = (persisted.sessions || []).find((item) => item.threadId === "slack:C123:22.0");
      expect(target?.codexSessionId).toBe("session-from-issue-record");
    } finally {
      if (prevBin === undefined) {
        delete process.env.ISSUE_HUNTER_CODEX_BIN;
      } else {
        process.env.ISSUE_HUNTER_CODEX_BIN = prevBin;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects switching issue binding inside one thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-issue-bind-"));
    const prevBin = process.env.ISSUE_HUNTER_CODEX_BIN;
    process.env.ISSUE_HUNTER_CODEX_BIN = "true";
    try {
      const repoRoot = join(root, "repo");
      await mkdir(repoRoot, { recursive: true });
      const repo = makeRepo(repoRoot);
      const config = makeConfig(repo);
      const configStore = {
        load: async () => config
      };

      const runner = async (command: string, args: string[]) => {
        if (command === "git" && args.includes("worktree") && args.includes("add")) {
          const target = args[args.length - 2];
          await mkdir(target, { recursive: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      const manager = new SlackChannelCodexManager(
        configStore as never,
        join(root, "runtime", "sessions.json"),
        runner as never
      );

      const first = await manager.handleMessage({
        threadId: "slack:C123:99.0",
        channelId: "C123",
        text: "第一次消息",
        isMention: false,
        issueKeyHint: "acme/web#185",
        post: async () => undefined
      });
      expect(first.accepted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 40));

      const second = await manager.handleMessage({
        threadId: "slack:C123:99.0",
        channelId: "C123",
        text: "第二次消息",
        isMention: false,
        issueKeyHint: "acme/web#175",
        post: async () => undefined
      });
      expect(second.accepted).toBe(true);
      expect(second.message).toContain("已绑定");
    } finally {
      if (prevBin === undefined) {
        delete process.env.ISSUE_HUNTER_CODEX_BIN;
      } else {
        process.env.ISSUE_HUNTER_CODEX_BIN = prevBin;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
});
