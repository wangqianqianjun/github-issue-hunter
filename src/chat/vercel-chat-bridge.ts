import type { Request, Response } from "express";
import { Chat, ConsoleLogger } from "chat";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { ConfigStore } from "../core/config-store.js";

export interface ServiceStatusProvider {
  (): Promise<{ running: boolean; activeTasks: number; queueLength: number; lastRunAt: string; lastError: string }>;
}

export interface ThreadStopResult {
  stopped: boolean;
  issueKey: string;
  message: string;
}

export interface ThreadStopProvider {
  (threadId: string): Promise<ThreadStopResult>;
}

export interface ThreadSignalResult {
  accepted: boolean;
  issueKey: string;
  message: string;
}

export interface ThreadSignalProvider {
  (threadId: string, text: string): Promise<ThreadSignalResult>;
}

export interface ChannelMessageResult {
  accepted: boolean;
  message: string;
}

export interface ChannelMessageProvider {
  (input: {
    threadId: string;
    channelId: string;
    text: string;
    isMention: boolean;
    post: (text: string) => Promise<void>;
  }): Promise<ChannelMessageResult>;
}

export interface SlackBridgeHealthSnapshot {
  socketModeEnabled: boolean;
  socketModeConnected: boolean;
  lastConnectedAt: string;
  lastDisconnectedAt: string;
  reconnectCount: number;
  duplicateEventsDropped: number;
  processedHumanEvents: number;
  lastSocketError: string;
  lastSocketErrorAt: string;
}

export class ChatSlackBridge {
  private chat: Chat<{ slack: SlackAdapter }> | null = null;
  private slackAdapter: SlackAdapter | null = null;
  private socketModeClient: SocketModeClient | null = null;
  private socketModeEnabled = false;
  private initializedFingerprint = "";
  private subscriptionFile = "";
  private slackEventLogFile = "";
  private subscribedThreadIds = new Set<string>();
  private warnedSocketModeMissingToken = false;
  private warnedSocketModeDisabledInWorker = false;
  private botUserId = "";
  private botId = "";
  private socketModeLastConnectedAt = 0;
  private socketModeLastDisconnectedAt = 0;
  private socketModeConnected = false;
  private socketModeReconnectCount = 0;
  private ignoredSelfEventCount = 0;
  private ignoredNonHumanEventCount = 0;
  private lastIgnoredSelfLogAt = 0;
  private lastIgnoredNonHumanLogAt = 0;
  private readonly socketEventDedup = new Map<string, number>();
  private duplicateSocketEventCount = 0;
  private lastDuplicateSocketEventLogAt = 0;
  private processedHumanEventCount = 0;
  private lastSocketError = "";
  private lastSocketErrorAt = 0;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly statusProvider: ServiceStatusProvider,
    private readonly stopProvider?: ThreadStopProvider,
    private readonly signalProvider?: ThreadSignalProvider,
    private readonly channelMessageProvider?: ChannelMessageProvider,
    private readonly onSocketModeReconnected?: () => Promise<void> | void
  ) {}

  getHealthSnapshot(): SlackBridgeHealthSnapshot {
    return {
      socketModeEnabled: this.socketModeEnabled,
      socketModeConnected: this.socketModeConnected,
      lastConnectedAt: this.socketModeLastConnectedAt ? new Date(this.socketModeLastConnectedAt).toISOString() : "",
      lastDisconnectedAt: this.socketModeLastDisconnectedAt
        ? new Date(this.socketModeLastDisconnectedAt).toISOString()
        : "",
      reconnectCount: this.socketModeReconnectCount,
      duplicateEventsDropped: this.duplicateSocketEventCount,
      processedHumanEvents: this.processedHumanEventCount,
      lastSocketError: this.lastSocketError,
      lastSocketErrorAt: this.lastSocketErrorAt ? new Date(this.lastSocketErrorAt).toISOString() : ""
    };
  }

  async ensureInitialized(): Promise<boolean> {
    const config = await this.configStore.load();
    if (!config.slackApp.enabled) {
      return false;
    }

    const botToken = resolveCredential(config.slackApp.botToken, config.slackApp.botTokenEnv);
    const signingSecret = resolveCredential(config.slackApp.signingSecret, config.slackApp.signingSecretEnv) || "unused";
    const appToken = resolveCredential(config.slackApp.appToken, config.slackApp.appTokenEnv);
    const socketModeRequested = Boolean(config.slackApp.useSocketMode);
    const socketModeAllowedInProcess = process.env.ISSUE_HUNTER_WORKER !== "1";
    const socketModeEnabled = socketModeRequested && Boolean(appToken) && socketModeAllowedInProcess;
    if (socketModeRequested && !socketModeAllowedInProcess && !this.warnedSocketModeDisabledInWorker) {
      this.warnedSocketModeDisabledInWorker = true;
      // eslint-disable-next-line no-console
      console.info(
        "[issue-hunter] Socket Mode listener is disabled in worker process; only the scheduler/main process consumes inbound Slack events."
      );
    }
    if (socketModeRequested && !socketModeEnabled && !this.warnedSocketModeMissingToken) {
      this.warnedSocketModeMissingToken = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[issue-hunter] Slack Socket Mode is enabled but app token is missing. " +
          "Set Slack App Token (xapp-...) in UI or env, otherwise inbound thread messages will not be consumed."
      );
    }
    if (!botToken) {
      return false;
    }

    this.subscriptionFile = resolveThreadSubscriptionFile(this.configStore.resolvedPath());
    this.slackEventLogFile = resolveSlackEventLogFile(this.configStore.resolvedPath());
    const fingerprint = `${botToken.length}:${signingSecret.length}:${appToken.length}:${socketModeEnabled ? 1 : 0}:${config.slackApp.botDisplayName}:${config.slackApp.appDisplayName}:${this.subscriptionFile}`;
    if (fingerprint === this.initializedFingerprint && this.chat && this.slackAdapter) {
      if ((!this.botUserId && !this.botId) || (Date.now() - this.socketModeLastConnectedAt > 15 * 60 * 1000)) {
        await this.refreshBotIdentity(botToken);
      }
      if (socketModeEnabled) {
        await this.ensureHealthySocketModeClient(appToken);
      }
      return true;
    }

    await this.refreshBotIdentity(botToken);

    await this.stopSocketModeClient();
    if (this.chat) {
      await this.chat.shutdown();
    }

    const logger = new ConsoleLogger("info", "chat-bridge");
    const slackAdapter = createSlackAdapter({
      botToken,
      signingSecret,
      clientId: resolveCredential(config.slackApp.clientId, config.slackApp.clientIdEnv) || undefined,
      clientSecret: resolveCredential(config.slackApp.clientSecret, config.slackApp.clientSecretEnv) || undefined,
      logger,
      userName: config.slackApp.botDisplayName
    });

    const chat = new Chat({
      adapters: {
        slack: slackAdapter
      },
      state: createMemoryState(),
      userName: config.slackApp.botDisplayName,
      logger
    });

    const handleControlCommands = async (
      thread: { id: string; post: (text: string) => Promise<unknown>; subscribe: () => Promise<void> },
      textRaw: string,
      silentIfNoTask = false
    ): Promise<boolean> => {
      const text = textRaw.trim().toLowerCase();
      if (!isStopCommand(text)) {
        return false;
      }

      if (!this.stopProvider) {
        if (!silentIfNoTask) {
          await thread.post("当前实例未启用停止控制能力。");
        }
        return true;
      }

      const result = await this.stopProvider(thread.id);
      if (result.stopped || !silentIfNoTask) {
        await thread.post(result.message);
      }
      return true;
    };

    chat.onNewMention(async (thread, message) => {
      await this.subscribeThread(thread.id).catch(() => undefined);
      await this.postReceivedEmoji(thread);
      if (await handleControlCommands(thread, message.text, false)) {
        return;
      }
      const text = message.text.trim().toLowerCase();
      if (text.includes("status")) {
        const status = await this.statusProvider();
        await thread.post(
          `Issue Hunter status: running=${status.running}, activeTasks=${status.activeTasks}, queue=${status.queueLength}`
        );
        return;
      }

      if (this.channelMessageProvider) {
        const channelResult = await this.channelMessageProvider({
          threadId: thread.id,
          channelId: resolveChannelIdFromThreadId(thread.id),
          text: message.text,
          isMention: true,
          post: async (text: string) => {
            await thread.post(text);
          }
        });
        if (channelResult.accepted) {
          if (channelResult.message) {
            await thread.post(channelResult.message);
          }
          return;
        }
      }

      if (this.signalProvider) {
        const signal = await this.signalProvider(thread.id, message.text);
        if (signal.accepted) {
          await thread.post(signal.message);
          return;
        }
      }

      await thread.post(
        "Issue Hunter 已接入 Vercel Chat SDK。可用命令: `status` 查看服务状态。"
      );
    });

    chat.onSubscribedMessage(async (thread, message) => {
      await this.postReceivedEmoji(thread);
      if (await handleControlCommands(thread, message.text, true)) {
        return;
      }
      const text = message.text.trim().toLowerCase();
      if (!text.includes("status")) {
        if (this.channelMessageProvider) {
          const channelResult = await this.channelMessageProvider({
            threadId: thread.id,
            channelId: resolveChannelIdFromThreadId(thread.id),
            text: message.text,
            isMention: false,
            post: async (text: string) => {
              await thread.post(text);
            }
          });
          if (channelResult.accepted) {
            if (channelResult.message) {
              await thread.post(channelResult.message);
            }
            return;
          }
        }

        if (this.signalProvider) {
          const signal = await this.signalProvider(thread.id, message.text);
          if (signal.accepted) {
            await thread.post(signal.message);
            return;
          }
        }
        return;
      }
      const status = await this.statusProvider();
      await thread.post(
        `Issue Hunter status: running=${status.running}, activeTasks=${status.activeTasks}, queue=${status.queueLength}`
      );
    });

    // Fallback handler for unsubscribed threads:
    // thread replies in Issue Hunter-created threads can still be consumed even before subscription is restored.
    chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
      if (message.isMention) {
        return;
      }
      await this.postReceivedEmoji(thread);
      if (await handleControlCommands(thread, message.text, true)) {
        return;
      }
      const text = message.text.trim().toLowerCase();
      if (text.includes("status")) {
        const status = await this.statusProvider();
        await thread.post(
          `Issue Hunter status: running=${status.running}, activeTasks=${status.activeTasks}, queue=${status.queueLength}`
        );
        return;
      }
      if (this.channelMessageProvider) {
        const channelResult = await this.channelMessageProvider({
          threadId: thread.id,
          channelId: resolveChannelIdFromThreadId(thread.id),
          text: message.text,
          isMention: false,
          post: async (text: string) => {
            await thread.post(text);
          }
        });
        if (channelResult.accepted) {
          if (channelResult.message) {
            await thread.post(channelResult.message);
          }
          return;
        }
      }
      if (this.signalProvider) {
        const signal = await this.signalProvider(thread.id, message.text);
        if (signal.accepted) {
          await thread.post(signal.message);
          return;
        }
      }
    });

    await chat.initialize();
    await this.restoreThreadSubscriptions(chat);

    this.chat = chat;
    this.slackAdapter = slackAdapter;
    this.socketModeEnabled = socketModeEnabled;
    this.initializedFingerprint = fingerprint;
    if (socketModeEnabled) {
      await this.startSocketModeClient(appToken);
    }
    return true;
  }

  async shutdown(): Promise<void> {
    await this.stopSocketModeClient();
    if (this.chat) {
      await this.chat.shutdown();
      this.chat = null;
    }
    this.slackAdapter = null;
    this.socketModeEnabled = false;
    this.socketModeConnected = false;
    this.initializedFingerprint = "";
  }

  async handleExpressWebhook(req: Request, res: Response): Promise<void> {
    const ok = await this.ensureInitialized();
    if (!ok || !this.chat) {
      res.status(503).json({ error: "Vercel Chat Slack bridge is not initialized" });
      return;
    }

    const bodyRaw = req.body instanceof Buffer ? req.body.toString("utf8") : "";
    const headers = new Headers(
      Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : String(v ?? "")] as [string, string])
    );

    const incoming = new Request(`${req.protocol}://${req.get("host")}${req.originalUrl}`, {
      method: req.method,
      headers,
      body: bodyRaw
    });

    const response = await this.chat.webhooks.slack(incoming, {
      waitUntil: (task) => {
        task.catch((error) => {
          // eslint-disable-next-line no-console
          console.error("Slack webhook background task failed", error);
        });
      }
    });

    res.status(response.status);
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });
    const payload = Buffer.from(await response.arrayBuffer());
    res.send(payload);
  }

  async postChannelMessage(channelId: string, text: string): Promise<{ threadId: string; messageId: string }> {
    const ok = await this.ensureInitialized();
    if (!ok || !this.chat) {
      throw new Error("Vercel Chat bridge unavailable");
    }

    const sent = await this.chat.channel(`slack:${channelId}`).post(text);
    const threadId = normalizePostedSlackThreadId(channelId, sent.threadId, sent.id);
    await this.subscribeThread(threadId).catch(() => undefined);
    return {
      threadId,
      messageId: sent.id
    };
  }

  async postThreadMessage(threadId: string, text: string): Promise<void> {
    const ok = await this.ensureInitialized();
    if (!ok || !this.slackAdapter) {
      throw new Error("Vercel Chat bridge unavailable");
    }
    await this.slackAdapter.postMessage(threadId, text);
  }

  private async startSocketModeClient(appToken: string): Promise<void> {
    if (!this.slackAdapter) {
      return;
    }

    const clientPingTimeout = parsePositiveNumber(
      process.env.ISSUE_HUNTER_SLACK_CLIENT_PING_TIMEOUT_MS,
      60_000
    );
    const serverPingTimeout = parsePositiveNumber(
      process.env.ISSUE_HUNTER_SLACK_SERVER_PING_TIMEOUT_MS,
      180_000
    );
    const client = new SocketModeClient({
      appToken,
      autoReconnectEnabled: true,
      clientPingTimeout,
      serverPingTimeout
    });
    void this.logSlackInfo(
      `[issue-hunter] Slack Socket Mode options clientPingTimeout=${clientPingTimeout}ms serverPingTimeout=${serverPingTimeout}ms`
    );
    client.on("connected", () => {
      const wasConnected = this.socketModeConnected;
      this.socketModeLastConnectedAt = Date.now();
      this.socketModeConnected = true;
      if (wasConnected || this.socketModeLastDisconnectedAt > 0) {
        this.socketModeReconnectCount += 1;
        void Promise.resolve(this.onSocketModeReconnected?.()).catch(() => undefined);
      }
      void this.logSlackInfo("[issue-hunter] Slack Socket Mode connected");
    });
    client.on("disconnected", (error: unknown) => {
      this.socketModeLastDisconnectedAt = Date.now();
      this.socketModeConnected = false;
      void this.logSlackWarn(
        `[issue-hunter] Slack Socket Mode disconnected ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    client.on("error", (error: unknown) => {
      this.lastSocketError = error instanceof Error ? error.message : String(error);
      this.lastSocketErrorAt = Date.now();
      void this.logSlackError(
        `[issue-hunter] Slack Socket Mode error ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    });
    // NOTE:
    // Node @slack/socket-mode emits concrete event names ("message", "app_mention", ...)
    // and a generic "slack_event" envelope, instead of an "events_api" event callback.
    // We consume "slack_event" to keep one stable entry point.
    client.on("slack_event", async (args: Record<string, unknown>) => {
      const ack = args.ack;
      if (typeof ack === "function") {
        try {
          await Promise.resolve(ack());
        } catch {
          // Ignore ack failures and continue handling event best-effort.
        }
      }

      const envelopeType = String(args.type || "").trim();
      const body = (args.body ?? {}) as Record<string, unknown>;
      if (envelopeType !== "events_api") {
        void this.logSlackInfo(`[issue-hunter][slack] ignore envelope type=${envelopeType || "-"}`);
        return;
      }

      const event = (body.event ?? {}) as Record<string, unknown>;
      if (!Object.keys(event).length) {
        void this.logSlackInfo("[issue-hunter][slack] events_api envelope received but body.event is empty");
        return;
      }
      this.logInboundEvent("received", event);

      const dedupKey = buildSocketEventDedupKey({
        envelopeId: String(body.event_id ?? args.envelope_id ?? "").trim(),
        event
      });
      if (this.isDuplicateSocketModeEvent(dedupKey)) {
        return;
      }

      await this.handleSocketModeEvent(event);
    });

    // Backward-compat fallback if older runtime emits "events_api" directly.
    client.on("events_api", async (args: Record<string, unknown>) => {
      const ack = args.ack;
      if (typeof ack === "function") {
        try {
          await Promise.resolve(ack());
        } catch {
          // Ignore ack failures and continue handling event best-effort.
        }
      }

      const event = (args.event ?? (args.body as Record<string, unknown> | undefined)?.event) as
        | Record<string, unknown>
        | undefined;
      if (!event) {
        void this.logSlackInfo("[issue-hunter][slack] legacy events_api callback received empty event");
        return;
      }
      this.logInboundEvent("received_legacy_events_api", event);
      const legacyDedupKey = buildSocketEventDedupKey({
        envelopeId: String((args.body as Record<string, unknown> | undefined)?.event_id ?? args.envelope_id ?? "").trim(),
        event
      });
      if (this.isDuplicateSocketModeEvent(legacyDedupKey)) {
        return;
      }
      await this.handleSocketModeEvent(event);
    });

    await client.start();
    this.socketModeClient = client;
  }

  private async stopSocketModeClient(): Promise<void> {
    const client = this.socketModeClient;
    this.socketModeClient = null;
    this.socketModeConnected = false;
    if (!client) {
      return;
    }

    try {
      client.removeAllListeners();
      await client.disconnect();
    } catch {
      // Ignore shutdown errors.
    }
  }

  private async ensureHealthySocketModeClient(appToken: string): Promise<void> {
    if (!this.socketModeEnabled) {
      return;
    }
    if (!appToken) {
      return;
    }

    if (!this.socketModeClient) {
      await this.startSocketModeClient(appToken);
      return;
    }

    const disconnectedLongEnough =
      this.socketModeLastDisconnectedAt > this.socketModeLastConnectedAt &&
      Date.now() - this.socketModeLastDisconnectedAt > 90_000;
    if (!disconnectedLongEnough) {
      return;
    }

    await this.logSlackWarn(
      "[issue-hunter] Slack Socket Mode stayed disconnected >90s. Recreating socket client."
    );
    await this.stopSocketModeClient();
    await this.startSocketModeClient(appToken);
  }

  private async refreshBotIdentity(botToken: string): Promise<void> {
    try {
      const auth = await new WebClient(botToken).auth.test();
      this.botUserId = String(auth.user_id ?? auth.user ?? "").trim();
      this.botId = String(auth.bot_id ?? "").trim();
      await this.logSlackInfo(
        `[issue-hunter][slack] bot identity user=${this.botUserId || "-"} bot_id=${this.botId || "-"}`
      );
    } catch {
      this.botUserId = "";
      this.botId = "";
      await this.logSlackWarn("[issue-hunter][slack] failed to resolve bot identity via auth.test");
    }
  }

  private async handleSocketModeEvent(event: Record<string, unknown>): Promise<void> {
    if (!this.socketModeEnabled || !this.slackAdapter) {
      return;
    }

    if (this.isSelfSlackEvent(event)) {
      this.recordIgnoredEvent("self");
      return;
    }

    if (!isHumanSocketModeEvent(event)) {
      this.recordIgnoredEvent("non_human");
      return;
    }

    const inbound = extractSocketModeInboundMessage(event);
    if (!inbound) {
      this.logInboundEvent("ignored_unparseable", event);
      return;
    }
    this.processedHumanEventCount += 1;

    void this.logSlackInfo(
      `[issue-hunter][slack] inbound parsed thread=${inbound.threadId} channel=${inbound.channelId} mention=${inbound.isMention} text="${previewText(inbound.text)}"`
    );

    await this.subscribeThread(inbound.threadId).catch(() => undefined);
    const thread = {
      id: inbound.threadId,
      post: async (text: string) => {
        await this.slackAdapter!.postMessage(inbound.threadId, text);
      }
    };
    await this.postReceivedEmoji(thread);

    const textRaw = inbound.text;
    const text = textRaw.trim().toLowerCase();

    if (isStopCommand(text)) {
      void this.logSlackInfo(`[issue-hunter][slack] branch=stop thread=${thread.id}`);
      if (!this.stopProvider) {
        if (inbound.isMention) {
          await thread.post("当前实例未启用停止控制能力。");
        }
        return;
      }

      const result = await this.stopProvider(thread.id);
      if (result.stopped || inbound.isMention) {
        await thread.post(result.message);
      }
      return;
    }

    if (text.includes("status")) {
      void this.logSlackInfo(`[issue-hunter][slack] branch=status thread=${thread.id}`);
      const status = await this.statusProvider();
      await thread.post(
        `Issue Hunter status: running=${status.running}, activeTasks=${status.activeTasks}, queue=${status.queueLength}`
      );
      return;
    }

    if (this.channelMessageProvider) {
      const channelResult = await this.channelMessageProvider({
        threadId: inbound.threadId,
        channelId: inbound.channelId,
        text: textRaw,
        isMention: inbound.isMention,
        post: thread.post
      });
      if (channelResult.accepted) {
        void this.logSlackInfo(`[issue-hunter][slack] branch=channel_message_accepted thread=${thread.id}`);
        if (channelResult.message) {
          await thread.post(channelResult.message);
        }
        return;
      }
    }

    if (this.signalProvider) {
      const signal = await this.signalProvider(thread.id, textRaw);
      if (signal.accepted) {
        void this.logSlackInfo(
          `[issue-hunter][slack] branch=issue_signal_accepted thread=${thread.id} issue=${signal.issueKey}`
        );
        await thread.post(signal.message);
        return;
      }
    }

    if (inbound.isMention) {
      void this.logSlackInfo(`[issue-hunter][slack] branch=mention_fallback thread=${thread.id}`);
      await thread.post("Issue Hunter 已接入 Slack Socket Mode。可用命令: `status` 查看服务状态。");
      return;
    }

    void this.logSlackInfo(`[issue-hunter][slack] branch=no_context_matched thread=${thread.id}`);
    await thread.post(
      "未匹配到可处理上下文：当前消息既不属于已关联 issue 线程，也没有命中已绑定仓库的频道处理。"
    );
  }

  private async restoreThreadSubscriptions(chat: Chat<{ slack: SlackAdapter }>): Promise<void> {
    const persisted = await loadThreadSubscriptions(this.subscriptionFile);
    this.subscribedThreadIds = new Set(persisted);
    for (const threadId of persisted) {
      try {
        await chat.getState().subscribe(threadId);
      } catch {
        // Ignore a single subscription restore failure and continue restoring the rest.
      }
    }
  }

  private async subscribeThread(threadIdRaw: string): Promise<void> {
    const threadId = normalizeSubscribableThreadId(threadIdRaw);
    if (!threadId || !this.chat) {
      return;
    }
    await this.chat.getState().subscribe(threadId);
    if (this.subscribedThreadIds.has(threadId)) {
      return;
    }
    this.subscribedThreadIds.add(threadId);
    await persistThreadSubscriptions(this.subscriptionFile, this.subscribedThreadIds);
  }

  private async postReceivedEmoji(thread: { post: (text: string) => Promise<unknown> }): Promise<void> {
    try {
      await thread.post("👀");
      void this.logSlackInfo("[issue-hunter][slack] posted ack emoji 👀");
    } catch {
      void this.logSlackWarn("[issue-hunter][slack] failed to post ack emoji 👀");
    }
  }

  private logInboundEvent(stage: string, event: Record<string, unknown>): void {
    const type = String(event.type || "").trim() || "-";
    const subtype = String(event.subtype || "").trim() || "-";
    const channel = String(event.channel || "").trim() || "-";
    const user = String(event.user || "").trim() || "-";
    const ts = String(event.ts || "").trim() || "-";
    const threadTs = String(event.thread_ts || "").trim() || "-";
    const nested = (event.message ?? {}) as Record<string, unknown>;
    const nestedUser = String(nested.user || "").trim();
    const nestedThreadTs = String(nested.thread_ts || "").trim();
    const nestedText = String(nested.text || "").trim();
    void this.logSlackInfo(
      `[issue-hunter][slack] event stage=${stage} type=${type} subtype=${subtype} channel=${channel} user=${user} ts=${ts} thread_ts=${threadTs} nested_user=${nestedUser || "-"} nested_thread_ts=${nestedThreadTs || "-"} nested_text="${previewText(nestedText)}"`
    );
  }

  private isSelfSlackEvent(event: Record<string, unknown>): boolean {
    const subtype = String(event.subtype || "").trim().toLowerCase();
    if (subtype === "bot_message") {
      return true;
    }

    const nestedMessage = (event.message ?? {}) as Record<string, unknown>;
    const topBotId = String(event.bot_id || "").trim();
    const nestedBotId = String(nestedMessage.bot_id || "").trim();
    if (topBotId || nestedBotId) {
      return true;
    }

    const eventUser = resolveEventUserId(event);
    if (this.botUserId && eventUser && eventUser === this.botUserId) {
      return true;
    }

    return false;
  }

  private async logSlackInfo(message: string): Promise<void> {
    await this.writeSlackLog("INFO", message);
  }

  private async logSlackWarn(message: string): Promise<void> {
    await this.writeSlackLog("WARN", message);
  }

  private async logSlackError(message: string): Promise<void> {
    await this.writeSlackLog("ERROR", message);
  }

  private async writeSlackLog(level: "INFO" | "WARN" | "ERROR", message: string): Promise<void> {
    const line = `${new Date().toISOString()} [${level}] ${message}\n`;
    if (level === "ERROR") {
      // eslint-disable-next-line no-console
      console.error(message);
    } else if (level === "WARN") {
      // eslint-disable-next-line no-console
      console.warn(message);
    } else {
      // eslint-disable-next-line no-console
      console.info(message);
    }

    const filePath = String(this.slackEventLogFile || "").trim();
    if (!filePath) {
      return;
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await appendFile(filePath, line, "utf8");
    } catch {
      // Ignore disk logging failures; console logging remains primary.
    }
  }

  private recordIgnoredEvent(type: "self" | "non_human"): void {
    const now = Date.now();
    const intervalMs = Math.max(10_000, Number(process.env.ISSUE_HUNTER_SLACK_IGNORED_EVENT_LOG_INTERVAL_MS || 60_000));

    if (type === "self") {
      this.ignoredSelfEventCount += 1;
      if (now - this.lastIgnoredSelfLogAt >= intervalMs) {
        const count = this.ignoredSelfEventCount;
        this.ignoredSelfEventCount = 0;
        this.lastIgnoredSelfLogAt = now;
        void this.logSlackInfo(`[issue-hunter][slack] ignored self events in window: ${count}`);
      }
      return;
    }

    this.ignoredNonHumanEventCount += 1;
    if (now - this.lastIgnoredNonHumanLogAt >= intervalMs) {
      const count = this.ignoredNonHumanEventCount;
      this.ignoredNonHumanEventCount = 0;
      this.lastIgnoredNonHumanLogAt = now;
      void this.logSlackInfo(`[issue-hunter][slack] ignored non-human events in window: ${count}`);
    }
  }

  private isDuplicateSocketModeEvent(keyRaw: string): boolean {
    const key = String(keyRaw || "").trim();
    if (!key) {
      return false;
    }

    const now = Date.now();
    const ttlMs = Math.max(30_000, Number(process.env.ISSUE_HUNTER_SLACK_EVENT_DEDUP_TTL_MS || 10 * 60 * 1000));
    const maxEntries = Math.max(1000, Number(process.env.ISSUE_HUNTER_SLACK_EVENT_DEDUP_MAX_ENTRIES || 20_000));
    const duplicateLogIntervalMs = Math.max(
      10_000,
      Number(process.env.ISSUE_HUNTER_SLACK_DEDUP_LOG_INTERVAL_MS || 60_000)
    );

    const cutoff = now - ttlMs;
    if (this.socketEventDedup.size >= maxEntries) {
      for (const [candidate, ts] of this.socketEventDedup) {
        if (ts < cutoff || this.socketEventDedup.size >= maxEntries) {
          this.socketEventDedup.delete(candidate);
        }
      }
    } else {
      for (const [candidate, ts] of this.socketEventDedup) {
        if (ts < cutoff) {
          this.socketEventDedup.delete(candidate);
        }
      }
    }

    const previous = this.socketEventDedup.get(key);
    this.socketEventDedup.set(key, now);
    if (previous === undefined || now - previous > ttlMs) {
      return false;
    }

    this.duplicateSocketEventCount += 1;
    if (now - this.lastDuplicateSocketEventLogAt >= duplicateLogIntervalMs) {
      const count = this.duplicateSocketEventCount;
      this.duplicateSocketEventCount = 0;
      this.lastDuplicateSocketEventLogAt = now;
      void this.logSlackInfo(`[issue-hunter][slack] duplicate socket events dropped in window: ${count}`);
    }
    return true;
  }
}

export function normalizePostedSlackThreadId(channelId: string, threadId: string, messageId: string): string {
  const channel = String(channelId || "").replace(/^slack:/, "").trim();
  const candidate = String(threadId || "").trim();
  if (hasConcreteSlackThreadTs(candidate)) {
    return candidate;
  }
  const messageTs = String(messageId || "").trim();
  if (channel && messageTs) {
    return `slack:${channel}:${messageTs}`;
  }
  if (candidate) {
    return candidate;
  }
  return `slack:${channel}:`;
}

function parsePositiveNumber(raw: string | undefined, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function hasConcreteSlackThreadTs(threadId: string): boolean {
  if (!threadId.startsWith("slack:")) {
    return false;
  }
  const parts = threadId.split(":");
  return parts.length >= 3 && parts.slice(2).join(":").trim().length > 0;
}

function normalizeSubscribableThreadId(threadIdRaw: string): string {
  const threadId = String(threadIdRaw || "").trim();
  if (!threadId) {
    return "";
  }
  return hasConcreteSlackThreadTs(threadId) ? threadId : "";
}

function resolveChannelIdFromThreadId(threadId: string): string {
  const raw = String(threadId || "").trim();
  if (!raw.startsWith("slack:")) {
    return "";
  }
  const parts = raw.split(":");
  if (parts.length < 3) {
    return "";
  }
  return String(parts[1] || "").trim();
}

interface ThreadSubscriptionSnapshot {
  threads: string[];
  updatedAt: string;
}

export function resolveThreadSubscriptionFile(configPath: string): string {
  const baseDir = dirname(resolve(configPath));
  return resolve(baseDir, "runtime", "chat-thread-subscriptions.json");
}

export function resolveSlackEventLogFile(configPath: string): string {
  const baseDir = dirname(resolve(configPath));
  return resolve(baseDir, "runtime", "slack-events.log");
}

export async function loadThreadSubscriptions(filePath: string): Promise<string[]> {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    return [];
  }
  try {
    const raw = await readFile(normalizedPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ThreadSubscriptionSnapshot>;
    const candidates = Array.isArray(parsed.threads) ? parsed.threads : [];
    const normalized = new Set<string>();
    for (const item of candidates) {
      const threadId = normalizeSubscribableThreadId(String(item || ""));
      if (threadId) {
        normalized.add(threadId);
      }
    }
    return [...normalized];
  } catch {
    return [];
  }
}

export async function persistThreadSubscriptions(filePath: string, threadIds: Iterable<string>): Promise<void> {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) {
    return;
  }

  const normalized = new Set<string>();
  for (const threadIdRaw of threadIds) {
    const threadId = normalizeSubscribableThreadId(threadIdRaw);
    if (threadId) {
      normalized.add(threadId);
    }
  }

  const payload: ThreadSubscriptionSnapshot = {
    threads: [...normalized].sort(),
    updatedAt: new Date().toISOString()
  };

  await mkdir(dirname(normalizedPath), { recursive: true });
  await writeFile(normalizedPath, JSON.stringify(payload, null, 2), "utf8");
}

export function isStopCommand(text: string): boolean {
  const raw = String(text || "").trim().toLowerCase();
  if (!raw) {
    return false;
  }

  if (/(^|\s)(stop|cancel|abort|terminate)(\s|$)/i.test(raw)) {
    return true;
  }

  return raw.includes("停止") || raw.includes("中止") || raw.includes("终止");
}

export function extractSocketModeInboundMessage(
  event: Record<string, unknown>
): { threadId: string; channelId: string; text: string; isMention: boolean } | null {
  const type = String(event.type || "").trim();
  const isMention = type === "app_mention";
  if (type !== "message" && !isMention) {
    return null;
  }

  const subtype = String(event.subtype || "").trim().toLowerCase();
  const nestedMessage = (event.message ?? {}) as Record<string, unknown>;

  const channel = String(event.channel || nestedMessage.channel || "").trim();
  if (!channel) {
    return null;
  }

  // message_replied events carry content under event.message.*
  if (subtype === "message_replied") {
    const user = String(nestedMessage.user || "").trim();
    const threadTs = String(nestedMessage.thread_ts || event.thread_ts || nestedMessage.ts || event.ts || "").trim();
    const text = String(nestedMessage.text || "").trim();
    if (!user || !threadTs || !text) {
      return null;
    }
    return {
      threadId: `slack:${channel}:${threadTs}`,
      channelId: channel,
      text,
      isMention
    };
  }

  if (subtype && subtype !== "thread_broadcast") {
    return null;
  }

  const user = String(event.user || "").trim();
  const threadTs = String(event.thread_ts || event.ts || "").trim();
  const text = String(event.text || "").trim();
  if (!user || !threadTs || !text) {
    return null;
  }

  return {
    threadId: `slack:${channel}:${threadTs}`,
    channelId: channel,
    text,
    isMention
  };
}

export function isHumanSocketModeEvent(event: Record<string, unknown>): boolean {
  const userId = resolveEventUserId(event);
  if (!userId) {
    return false;
  }

  const nestedMessage = (event.message ?? {}) as Record<string, unknown>;
  const topBotId = String(event.bot_id || "").trim();
  const nestedBotId = String(nestedMessage.bot_id || "").trim();
  if (topBotId || nestedBotId) {
    return false;
  }

  const subtype = String(event.subtype || "").trim().toLowerCase();
  if (subtype === "bot_message" || subtype === "message_changed" || subtype === "message_deleted") {
    return false;
  }

  // Strict human-only rule: Slack client-originated user messages carry client_msg_id.
  const topClientMsgId = String(event.client_msg_id || "").trim();
  const nestedClientMsgId = String(nestedMessage.client_msg_id || "").trim();
  return Boolean(topClientMsgId || nestedClientMsgId);
}

export function buildSocketEventDedupKey(input: {
  envelopeId?: string;
  event: Record<string, unknown>;
}): string {
  const envelopeId = String(input.envelopeId || "").trim();
  if (envelopeId) {
    return `envelope:${envelopeId}`;
  }

  const event = input.event ?? {};
  const nestedMessage = (event.message ?? {}) as Record<string, unknown>;
  const type = String(event.type || "").trim();
  const subtype = String(event.subtype || "").trim();
  const channel = String(event.channel || nestedMessage.channel || "").trim();
  const user = resolveEventUserId(event);
  const threadTs = String(event.thread_ts || nestedMessage.thread_ts || "").trim();
  const ts = String(event.event_ts || event.ts || nestedMessage.ts || "").trim();
  const clientMsgId = String(event.client_msg_id || nestedMessage.client_msg_id || "").trim();
  const text = previewText(String(event.text || nestedMessage.text || "").trim(), 80);

  return [
    "event",
    type || "-",
    subtype || "-",
    channel || "-",
    user || "-",
    threadTs || "-",
    ts || "-",
    clientMsgId || "-",
    text || "-"
  ].join("|");
}

function resolveCredential(directValue: string, envName: string): string {
  if (directValue?.trim()) {
    return directValue.trim();
  }
  if (!envName) {
    return "";
  }
  return process.env[envName] ?? "";
}

function previewText(text: string, maxLength = 120): string {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) {
    return "";
  }
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function resolveEventUserId(event: Record<string, unknown>): string {
  const directUser = String(event.user || "").trim();
  if (directUser) {
    return directUser;
  }
  const nestedMessage = (event.message ?? {}) as Record<string, unknown>;
  return String(nestedMessage.user || "").trim();
}
