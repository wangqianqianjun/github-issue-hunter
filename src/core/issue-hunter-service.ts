import { spawn, type ChildProcess } from "node:child_process";
import { dirname, extname, join, resolve } from "node:path";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WebClient } from "@slack/web-api";

import { ConfigStore } from "./config-store.js";
import { IssueEngine } from "./issue-engine.js";
import { FileRuntimeStore } from "./runtime-store.js";
import { GhCliClient } from "../clients/gh-cli-client.js";
import { CodexRunner } from "./codex-runner.js";
import { DirectSlackNotifier, ChatSdkNotifier } from "../chat/notifiers.js";
import { ChatSlackBridge, type SlackBridgeHealthSnapshot } from "../chat/vercel-chat-bridge.js";
import { WorkspaceManager } from "./workspace-manager.js";
import { writeRegressionCase } from "./report-writer.js";
import type { AppConfig, IssueExecutionRecord, RepositoryConfig } from "../types/config.js";
import {
  SlackChannelCodexManager,
  type ChannelMessageResult
} from "./slack-channel-codex-manager.js";

interface ServiceStatus {
  running: boolean;
  activeTasks: number;
  queueLength: number;
  lastRunAt: string;
  lastError: string;
  lastHealthAt?: string;
}

export interface BoardCard {
  issueKey: string;
  repoId: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  state: IssueExecutionRecord["state"];
  summary: string;
  rootCause: string;
  solution: string;
  prUrl: string;
  closedAt: string;
  updatedAt: string;
}

export interface BoardDiscussionComment {
  id: string;
  author: string;
  createdAt: string;
  updatedAt: string;
  url: string;
  body: string;
  bodyHtml: string;
}

export interface BoardIssueSource {
  number: number;
  title: string;
  state: string;
  url: string;
  createdAt: string;
  updatedAt: string;
  closedAt: string;
  body: string;
  bodyHtml: string;
}

export interface BoardDetail {
  issueKey: string;
  repoId: string;
  repoFullName: string;
  issueNumber: number;
  state: IssueExecutionRecord["state"];
  issueUrl: string;
  updatedAt: string;
  closedAt: string;
  prUrl: string;
  summary: string;
  rootCause: string;
  solution: string;
  issue: BoardIssueSource | null;
  discussion: BoardDiscussionComment[];
}

interface RegressionCaseSnapshot {
  issueKey: string;
  repoId: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  summary: string;
  rootCause: string;
  solution: string;
  prUrl: string;
  updatedAt: string;
  closedAt: string;
}

interface RunningWorker {
  child: ChildProcess;
  issueKey: string;
  repoId: string;
  issueNumber: number;
  startedAt: string;
  threadTokens: Set<string>;
  lastHeartbeatAtMs: number;
  lastMessageAtMs: number;
  forcedTerminationReason?: string;
}

interface WorkerTask {
  repo: RepositoryConfig;
  issueNumber: number;
  issueKey: string;
  triggerType: "new" | "retry_failed" | "new_comment" | "slack_signal" | "approval" | "manual" | "stale_recovery";
}

interface WorkerMessage {
  type?: string;
  issueKey?: string;
  threadToken?: string;
  stopped?: boolean;
  message?: string;
  at?: string;
}

interface ServiceHealthStatus {
  now: string;
  service: ServiceStatus & {
    runOnceInFlight: boolean;
    schedulerTickLagMs: number;
  };
  workers: {
    active: number;
    stale: number;
    heartbeatTimeoutSeconds: number;
    items: Array<{
      issueKey: string;
      repoId: string;
      issueNumber: number;
      startedAt: string;
      lastHeartbeatAt: string;
      lastMessageAt: string;
      forcedTerminationReason: string;
    }>;
  };
  slack: SlackBridgeHealthSnapshot;
  scans: {
    repositoryScanErrorTotal: number;
    repositoryScanErrorByCategory: Record<string, number>;
    lastRepositoryScanErrorAt: string;
    lastRepositoryScanError: string;
  };
  counters: {
    runCycles: number;
    runFailures: number;
    workerFailures: number;
    reconnectRecoveries: number;
  };
}

export class IssueHunterService {
  private timer: NodeJS.Timeout | null = null;
  private runOnceInFlight: Promise<void> | null = null;
  private lastSchedulerTickMs = 0;
  private lastSocketReconnectRecoveryAtMs = 0;
  private runCycles = 0;
  private runFailures = 0;
  private workerFailures = 0;
  private reconnectRecoveries = 0;
  private lastSummaryLogAtMs = 0;
  private repositoryScanErrorTotal = 0;
  private readonly repositoryScanErrorByCategory: Record<string, number> = {
    transient: 0,
    logic: 0,
    config: 0,
    cancelled: 0,
    unknown: 0
  };
  private lastRepositoryScanErrorAt = "";
  private lastRepositoryScanError = "";
  private readonly runtimeStore: FileRuntimeStore;
  private readonly chatBridge: ChatSlackBridge;
  private readonly slackChannelCodexManager: SlackChannelCodexManager;
  private readonly engine: IssueEngine;
  private readonly workersByIssueKey = new Map<string, RunningWorker>();
  private readonly issueKeyByThreadToken = new Map<string, string>();
  private readonly paths: {
    runtimeFile: string;
    regressionDir: string;
    channelSessionFile: string;
  };

  private status: ServiceStatus = {
    running: false,
    activeTasks: 0,
    queueLength: 0,
    lastRunAt: "",
    lastError: ""
  };

  constructor(private readonly configStore: ConfigStore) {
    const configPath = this.configStore.resolvedPath();
    const stateRoot = resolve(dirname(configPath), "runtime");
    this.paths = {
      runtimeFile: join(stateRoot, "issues.json"),
      regressionDir: join(stateRoot, "regression_cases"),
      channelSessionFile: join(stateRoot, "slack-channel-sessions.json")
    };

    this.runtimeStore = new FileRuntimeStore(this.paths.runtimeFile);
    this.slackChannelCodexManager = new SlackChannelCodexManager(
      this.configStore,
      join(stateRoot, "slack-channel-sessions.json")
    );
    this.chatBridge = new ChatSlackBridge(
      this.configStore,
      async () => this.getStatus(),
      async (threadId) => this.stopByThread(threadId),
      async (threadId, text) => this.registerSlackSignal(threadId, text),
      async (input) => this.handleSlackChannelMessage(input),
      async () => this.handleSocketModeReconnected()
    );

    // Scheduler-only engine: it discovers pending issues and dispatches workers.
    this.engine = new IssueEngine({
      getConfig: async () => this.configStore.load(),
      runtimeStore: this.runtimeStore,
      githubFactory: (repo) =>
        new GhCliClient({
          owner: repo.owner,
          repo: repo.repo,
          localPath: repo.localPath
        }),
      codexFactory: () =>
        new CodexRunner({
          triageCommand: "echo '{\"needs_processing\":false}'",
          implementCommand: "echo '{}'",
          defaultWorkingDirectory: process.cwd()
        }),
      notifierFactory: () => null,
      onRepositoryScanError: async (input) => this.onRepositoryScanError(input),
      externalTaskExecutor: async (task) => this.dispatchWorker(task),
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined
    });
  }

  async start(): Promise<void> {
    if (this.timer) {
      return;
    }

    await this.initializeRealtimeIntegrations();

    const config = await this.configStore.load();
    const intervalMs = Math.max(5, Number(config.global.pollIntervalSeconds || 30)) * 1000;

    this.status.running = true;
    this.status.lastHealthAt = new Date().toISOString();
    await this.configStore.updateServiceState({
      running: true,
      lastError: "",
      activeTasks: this.workersByIssueKey.size,
      lastHealthAt: this.status.lastHealthAt
    });

    await this.runOnceSafe().catch(() => undefined);
    this.lastSchedulerTickMs = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      const driftMs = now - this.lastSchedulerTickMs - intervalMs;
      this.lastSchedulerTickMs = now;

      if (driftMs > Math.max(60_000, intervalMs * 2)) {
        // eslint-disable-next-line no-console
        console.warn(
          `[issue-hunter] Scheduler drift detected (${driftMs}ms). ` +
            "Possible system sleep/network pause. Reinitializing Slack bridge and running catch-up scan."
        );
        void this.initializeRealtimeIntegrations().catch(() => undefined);
      }

      void this.runOnceSafe().catch(() => undefined);
    }, intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.lastSchedulerTickMs = 0;

    for (const worker of this.workersByIssueKey.values()) {
      try {
        if (worker.child.connected && worker.child.send) {
          worker.child.send({ type: "stop", issueKey: worker.issueKey });
        } else {
          worker.child.kill("SIGTERM");
        }
      } catch {
        // Ignore process termination errors while stopping service.
      }
    }

    this.status.running = false;
    this.status.lastHealthAt = new Date().toISOString();
    await this.chatBridge.shutdown().catch(() => undefined);
    await this.configStore.updateServiceState({
      running: false,
      activeTasks: this.workersByIssueKey.size,
      lastHealthAt: this.status.lastHealthAt
    });
  }

  async runOnce(): Promise<void> {
    await this.initializeRealtimeIntegrations();
    await this.runOnceSafe();
  }

  async initializeRealtimeIntegrations(): Promise<void> {
    await this.chatBridge.ensureInitialized().catch(() => undefined);
  }

  async getStatus(): Promise<ServiceStatus> {
    const config = await this.configStore.load();
    const merged: ServiceStatus = {
      ...this.status,
      running: Boolean(this.timer),
      activeTasks: this.workersByIssueKey.size,
      lastRunAt: this.status.lastRunAt || config.serviceState.lastRunAt,
      lastError: this.status.lastError || config.serviceState.lastError,
      lastHealthAt: this.status.lastHealthAt || config.serviceState.lastHealthAt || "",
      queueLength: 0
    };
    return merged;
  }

  async getHealthStatus(): Promise<ServiceHealthStatus> {
    const status = await this.getStatus();
    const now = Date.now();
    const heartbeatTimeoutSeconds = getWorkerHeartbeatTimeoutSeconds();
    const staleBoundaryMs = heartbeatTimeoutSeconds * 1000;
    let staleCount = 0;

    const workers = [...this.workersByIssueKey.values()].map((worker) => {
      const lastHeartbeatAtMs = worker.lastHeartbeatAtMs || Date.parse(worker.startedAt) || 0;
      const lastMessageAtMs = worker.lastMessageAtMs || Date.parse(worker.startedAt) || 0;
      const baseline = Math.max(lastHeartbeatAtMs, lastMessageAtMs);
      if (baseline > 0 && now - baseline >= staleBoundaryMs) {
        staleCount += 1;
      }
      return {
        issueKey: worker.issueKey,
        repoId: worker.repoId,
        issueNumber: worker.issueNumber,
        startedAt: worker.startedAt,
        lastHeartbeatAt: lastHeartbeatAtMs > 0 ? new Date(lastHeartbeatAtMs).toISOString() : "",
        lastMessageAt: lastMessageAtMs > 0 ? new Date(lastMessageAtMs).toISOString() : "",
        forcedTerminationReason: String(worker.forcedTerminationReason || "")
      };
    });

    return {
      now: new Date(now).toISOString(),
      service: {
        ...status,
        runOnceInFlight: Boolean(this.runOnceInFlight),
        schedulerTickLagMs: this.lastSchedulerTickMs ? Math.max(0, now - this.lastSchedulerTickMs) : 0
      },
      workers: {
        active: workers.length,
        stale: staleCount,
        heartbeatTimeoutSeconds,
        items: workers
      },
      slack: this.chatBridge.getHealthSnapshot(),
      scans: {
        repositoryScanErrorTotal: this.repositoryScanErrorTotal,
        repositoryScanErrorByCategory: { ...this.repositoryScanErrorByCategory },
        lastRepositoryScanErrorAt: this.lastRepositoryScanErrorAt,
        lastRepositoryScanError: this.lastRepositoryScanError
      },
      counters: {
        runCycles: this.runCycles,
        runFailures: this.runFailures,
        workerFailures: this.workerFailures,
        reconnectRecoveries: this.reconnectRecoveries
      }
    };
  }

  async handleSlackWebhook(request: import("express").Request, response: import("express").Response): Promise<void> {
    await this.chatBridge.handleExpressWebhook(request, response);
  }

  async listBoardCards(): Promise<BoardCard[]> {
    const config = await this.configStore.load();
    const records = await this.runtimeStore.listAll();
    const runtimeCards = records
      .filter((record) => isBoardVisibleState(record.state))
      .map((record) => {
        const parsed = parseIssueKey(record.issueKey, record.issueNumber);
        return {
          issueKey: record.issueKey,
          repoId: record.repoId,
          repoFullName: parsed.repoFullName,
          issueNumber: parsed.issueNumber,
          issueUrl: `https://github.com/${parsed.repoFullName}/issues/${parsed.issueNumber}`,
          state: record.state,
          summary: record.summary,
          rootCause: record.rootCause,
          solution: record.solution,
          prUrl: record.prUrl,
          closedAt: record.closedAt,
          updatedAt: record.updatedAt
        };
      });

    const exists = new Set(records.map((item) => `${item.repoId}#${item.issueNumber}`));
    const regressionFallback = await this.loadRegressionCaseSnapshots(config, exists);
    const merged = runtimeCards.concat(
      regressionFallback.map((item) => ({
        issueKey: item.issueKey,
        repoId: item.repoId,
        repoFullName: item.repoFullName,
        issueNumber: item.issueNumber,
        issueUrl: item.issueUrl,
        state: "completed" as const,
        summary: item.summary,
        rootCause: item.rootCause,
        solution: item.solution,
        prUrl: item.prUrl,
        closedAt: item.closedAt,
        updatedAt: item.updatedAt
      }))
    );

    return merged.slice().sort((a, b) => {
      const aWeight = boardStateWeight(a.state);
      const bWeight = boardStateWeight(b.state);
      if (aWeight !== bWeight) {
        return aWeight - bWeight;
      }

      const aTime = Date.parse(a.updatedAt || a.closedAt || "");
      const bTime = Date.parse(b.updatedAt || b.closedAt || "");
      return (Number.isFinite(bTime) ? bTime : 0) - (Number.isFinite(aTime) ? aTime : 0);
    });
  }

  async getBoardDetail(repoId: string, issueNumber: number): Promise<BoardDetail | null> {
    const normalizedRepoId = String(repoId || "").trim();
    const normalizedIssueNumber = Number(issueNumber);
    if (!normalizedRepoId || !Number.isFinite(normalizedIssueNumber) || normalizedIssueNumber <= 0) {
      return null;
    }

    const config = await this.configStore.load();
    const records = await this.runtimeStore.listAll();
    let record = records.find(
      (item) => item.repoId === normalizedRepoId && Number(item.issueNumber) === normalizedIssueNumber
    );
    if (!record) {
      const fallback = await this.findRegressionCaseSnapshot(config, normalizedRepoId, normalizedIssueNumber);
      if (!fallback) {
        return null;
      }

      record = {
        issueKey: fallback.issueKey,
        repoId: fallback.repoId,
        issueNumber: fallback.issueNumber,
        state: "completed",
        summary: fallback.summary,
        prUrl: fallback.prUrl,
        rootCause: fallback.rootCause,
        solution: fallback.solution,
        closedAt: fallback.closedAt,
        threadTs: "",
        updatedAt: fallback.updatedAt
      };
    }

    const parsed = parseIssueKey(record.issueKey, record.issueNumber);
    const repo = config.repositories.find((item) => item.id === normalizedRepoId);
    const repoFullName = repo ? `${repo.owner}/${repo.repo}` : parsed.repoFullName;
    const issueUrl = `https://github.com/${repoFullName}/issues/${normalizedIssueNumber}`;

    let issueSource: BoardIssueSource | null = null;
    let discussion: BoardDiscussionComment[] = [];
    if (repo) {
      try {
        const github = new GhCliClient({
          owner: repo.owner,
          repo: repo.repo,
          localPath: repo.localPath
        });

        const issue = await github.getIssue(normalizedIssueNumber);
        const comments = await github.listIssueComments(normalizedIssueNumber);

        issueSource = {
          number: Number(issue.number || normalizedIssueNumber),
          title: String(issue.title || ""),
          state: String(issue.state || ""),
          url: String(issue.html_url || issue.url || issueUrl),
          createdAt: String(issue.created_at || ""),
          updatedAt: String(issue.updated_at || ""),
          closedAt: String(issue.closed_at || ""),
          body: String(issue.body || ""),
          bodyHtml: String(issue.body_html || "")
        };

        discussion = comments
          .map((item) => ({
            id: String(item.id || ""),
            author: String((item.user as Record<string, unknown> | undefined)?.login || ""),
            createdAt: String(item.created_at || ""),
            updatedAt: String(item.updated_at || ""),
            url: String(item.html_url || ""),
            body: String(item.body || ""),
            bodyHtml: String(item.body_html || "")
          }))
          .sort((a, b) => Date.parse(a.createdAt || "") - Date.parse(b.createdAt || ""));
      } catch {
        // Keep board detail available even when GitHub API query fails.
      }
    }

    return {
      issueKey: record.issueKey,
      repoId: record.repoId,
      repoFullName,
      issueNumber: normalizedIssueNumber,
      state: record.state,
      issueUrl,
      updatedAt: String(record.updatedAt || ""),
      closedAt: String(record.closedAt || ""),
      prUrl: String(record.prUrl || ""),
      summary: String(record.summary || ""),
      rootCause: String(record.rootCause || ""),
      solution: String(record.solution || ""),
      issue: issueSource,
      discussion
    };
  }

  private async loadRegressionCaseSnapshots(
    config: AppConfig,
    existing: Set<string>
  ): Promise<RegressionCaseSnapshot[]> {
    let files: string[] = [];
    try {
      files = await readdir(this.paths.regressionDir);
    } catch {
      return [];
    }

    const results: RegressionCaseSnapshot[] = [];
    for (const name of files) {
      const parsed = parseRegressionCaseFilename(name);
      if (!parsed) {
        continue;
      }

      const dedupeKey = `${parsed.repoId}#${parsed.issueNumber}`;
      if (existing.has(dedupeKey)) {
        continue;
      }

      const snapshot = await this.readRegressionCaseSnapshot(config, parsed.repoId, parsed.issueNumber, name);
      if (!snapshot) {
        continue;
      }
      results.push(snapshot);
    }
    return results;
  }

  private async findRegressionCaseSnapshot(
    config: AppConfig,
    repoId: string,
    issueNumber: number
  ): Promise<RegressionCaseSnapshot | null> {
    let files: string[] = [];
    try {
      files = await readdir(this.paths.regressionDir);
    } catch {
      return null;
    }

    for (const name of files) {
      const parsed = parseRegressionCaseFilename(name);
      if (!parsed) {
        continue;
      }
      if (parsed.repoId !== repoId || parsed.issueNumber !== issueNumber) {
        continue;
      }
      return await this.readRegressionCaseSnapshot(config, repoId, issueNumber, name);
    }
    return null;
  }

  private async readRegressionCaseSnapshot(
    config: AppConfig,
    repoId: string,
    issueNumber: number,
    fileName: string
  ): Promise<RegressionCaseSnapshot | null> {
    const filePath = join(this.paths.regressionDir, fileName);
    let content = "";
    try {
      content = await readFile(filePath, "utf8");
    } catch {
      return null;
    }

    const metadata = parseRegressionCaseMarkdown(content);
    const repo = config.repositories.find((item) => item.id === repoId);
    const repoFullName = repo ? `${repo.owner}/${repo.repo}` : metadata.repoFullName || "unknown/unknown";
    const issueKey = `${repoFullName}#${issueNumber}`;
    const issueUrl = `https://github.com/${repoFullName}/issues/${issueNumber}`;

    let updatedAt = "";
    try {
      const fileStat = await stat(filePath);
      updatedAt = fileStat.mtime.toISOString();
    } catch {
      updatedAt = "";
    }

    return {
      issueKey,
      repoId,
      repoFullName,
      issueNumber,
      issueUrl,
      summary: metadata.summary,
      rootCause: metadata.rootCause,
      solution: metadata.solution,
      prUrl: metadata.prUrl,
      updatedAt,
      closedAt: updatedAt
    };
  }

  private async runOnceSafe(): Promise<void> {
    if (this.runOnceInFlight) {
      await this.runOnceInFlight;
      return;
    }

    this.runOnceInFlight = (async () => {
      try {
        await this.inspectWorkerHeartbeats();
        await this.engine.runOnce();
        this.runCycles += 1;
        this.status.lastRunAt = new Date().toISOString();
        this.status.lastError = "";
      } catch (error) {
        this.runFailures += 1;
        const message = error instanceof Error ? error.message : String(error);
        this.status.lastError = message;

        await this.configStore.updateServiceState({
          lastError: message,
          lastRunAt: new Date().toISOString(),
          running: Boolean(this.timer),
          activeTasks: this.workersByIssueKey.size,
          lastHealthAt: new Date().toISOString()
        });

        throw error;
      } finally {
        this.status.activeTasks = this.workersByIssueKey.size;
        this.status.lastHealthAt = new Date().toISOString();
        this.maybeLogHealthSummary();
        await this.configStore.updateServiceState({
          running: Boolean(this.timer),
          lastRunAt: this.status.lastRunAt,
          lastError: this.status.lastError,
          activeTasks: this.workersByIssueKey.size,
          lastHealthAt: this.status.lastHealthAt
        });
      }
    })();

    try {
      await this.runOnceInFlight;
    } finally {
      this.runOnceInFlight = null;
    }
  }

  private async onRepositoryScanError(input: {
    repo: RepositoryConfig;
    error: string;
    category: "transient" | "logic" | "config" | "cancelled" | "unknown";
    retryEligible: boolean;
  }): Promise<void> {
    const category = String(input.category || "unknown").trim() as keyof typeof this.repositoryScanErrorByCategory;
    if (category in this.repositoryScanErrorByCategory) {
      this.repositoryScanErrorByCategory[category] += 1;
    } else {
      this.repositoryScanErrorByCategory.unknown += 1;
    }
    this.repositoryScanErrorTotal += 1;
    this.lastRepositoryScanErrorAt = new Date().toISOString();
    this.lastRepositoryScanError = `${input.repo.owner}/${input.repo.repo}: ${input.error}`;

    const retryHint = input.retryEligible ? "retry=true" : "retry=false";
    // eslint-disable-next-line no-console
    console.warn(
      `[issue-hunter] repository scan error repo=${input.repo.owner}/${input.repo.repo} category=${category} ${retryHint} detail=${input.error}`
    );
  }

  private async handleSocketModeReconnected(): Promise<void> {
    const throttleMs = Math.max(
      5_000,
      Number(process.env.ISSUE_HUNTER_SOCKET_RECONNECT_CATCHUP_THROTTLE_MS || 20_000)
    );
    const now = Date.now();
    if (this.lastSocketReconnectRecoveryAtMs > 0 && now - this.lastSocketReconnectRecoveryAtMs < throttleMs) {
      return;
    }
    this.lastSocketReconnectRecoveryAtMs = now;
    this.reconnectRecoveries += 1;
    // eslint-disable-next-line no-console
    console.info("[issue-hunter] Socket Mode reconnected. Triggering catch-up runOnce.");
    await this.runOnceSafe().catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      // eslint-disable-next-line no-console
      console.warn(`[issue-hunter] catch-up runOnce after reconnect failed: ${detail}`);
    });
  }

  private async inspectWorkerHeartbeats(): Promise<void> {
    if (!this.workersByIssueKey.size) {
      return;
    }
    const timeoutSeconds = getWorkerHeartbeatTimeoutSeconds();
    const timeoutMs = timeoutSeconds * 1000;
    const now = Date.now();
    for (const worker of this.workersByIssueKey.values()) {
      const startedAtMs = Date.parse(worker.startedAt);
      const baseline = Math.max(
        worker.lastHeartbeatAtMs || 0,
        worker.lastMessageAtMs || 0,
        Number.isFinite(startedAtMs) ? startedAtMs : 0
      );
      if (!baseline) {
        continue;
      }
      if (now - baseline < timeoutMs) {
        continue;
      }
      if (worker.forcedTerminationReason) {
        continue;
      }

      worker.forcedTerminationReason = `Issue worker heartbeat timeout (${worker.issueKey}, timeout=${timeoutSeconds}s)`;
      // eslint-disable-next-line no-console
      console.warn(`[issue-hunter] ${worker.forcedTerminationReason}`);
      try {
        worker.child.kill("SIGTERM");
      } catch {
        // Ignore termination race and rely on exit handler.
      }
      setTimeout(() => {
        try {
          if (!worker.child.killed) {
            worker.child.kill("SIGKILL");
          }
        } catch {
          // Ignore kill escalation errors.
        }
      }, 5000);
    }
  }

  private maybeLogHealthSummary(): void {
    const now = Date.now();
    const summaryIntervalMs = Math.max(10_000, Number(process.env.ISSUE_HUNTER_HEALTH_LOG_INTERVAL_MS || 60_000));
    if (now - this.lastSummaryLogAtMs < summaryIntervalMs) {
      return;
    }
    this.lastSummaryLogAtMs = now;
    const slack = this.chatBridge.getHealthSnapshot();
    // eslint-disable-next-line no-console
    console.info(
      "[issue-hunter][health] " +
        `running=${Boolean(this.timer)} activeWorkers=${this.workersByIssueKey.size} runCycles=${this.runCycles} ` +
        `runFailures=${this.runFailures} workerFailures=${this.workerFailures} ` +
        `repoScanErrors=${this.repositoryScanErrorTotal} socketConnected=${slack.socketModeConnected} ` +
        `socketReconnects=${slack.reconnectCount} duplicateEventsDropped=${slack.duplicateEventsDropped}`
    );
  }

  private async stopByThread(threadToken: string): Promise<{ stopped: boolean; issueKey: string; message: string }> {
    const channelStopResult = await this.slackChannelCodexManager.stopByThread(threadToken);
    if (channelStopResult.stopped) {
      return channelStopResult;
    }

    const issueKey = await this.resolveIssueKeyByThreadToken(threadToken);
    if (!issueKey) {
      return {
        stopped: false,
        issueKey: "",
        message: "当前 thread 没有关联运行中的任务。"
      };
    }

    const worker = this.workersByIssueKey.get(issueKey);
    if (!worker) {
      return {
        stopped: false,
        issueKey,
        message: `Issue ${issueKey} 当前没有可停止的运行中 worker。`
      };
    }

    try {
      if (worker.child.connected && worker.child.send) {
        worker.child.send({
          type: "stop",
          issueKey,
          threadToken
        });
      } else {
        worker.child.kill("SIGTERM");
      }

      return {
        stopped: true,
        issueKey,
        message: `已向 issue ${issueKey} 发送停止指令。`
      };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return {
        stopped: false,
        issueKey,
        message: `停止 issue ${issueKey} 失败: ${detail}`
      };
    }
  }

  private async resolveIssueKeyByThreadToken(threadToken: string): Promise<string> {
    const aliases = deriveThreadTokenAliases(threadToken);
    for (const alias of aliases) {
      const issueKey = this.issueKeyByThreadToken.get(alias);
      if (issueKey) {
        return issueKey;
      }
    }

    const records = await this.runtimeStore.listAll();
    for (const record of records) {
      const thread = String(record.threadTs || "").trim();
      if (!thread) {
        continue;
      }
      const recordAliases = deriveThreadTokenAliases(thread);
      if (aliases.some((alias) => recordAliases.includes(alias))) {
        return record.issueKey;
      }
    }

    const recoveredIssueKey = await this.resolveIssueKeyFromSlackRootMessage(threadToken);
    if (recoveredIssueKey) {
      return recoveredIssueKey;
    }

    return "";
  }

  private async registerSlackSignal(
    threadToken: string,
    text: string
  ): Promise<{ accepted: boolean; issueKey: string; message: string }> {
    const issueKey = await this.resolveIssueKeyByThreadToken(threadToken);
    if (!issueKey) {
      return {
        accepted: false,
        issueKey: "",
        message: ""
      };
    }

    let existing = await this.runtimeStore.getRecord(issueKey);
    if (!existing) {
      existing = await this.recoverRecordForSlackSignal(issueKey, threadToken);
    }
    if (!existing) {
      return {
        accepted: false,
        issueKey,
        message: ""
      };
    }

    const now = new Date().toISOString();
    await this.runtimeStore.saveRecord({
      ...existing,
      lastSlackSignalAt: now,
      lastSlackSignalText: String(text || "").trim(),
      updatedAt: now
    });

    void this.runOnceSafe().catch(() => undefined);

    return {
      accepted: true,
      issueKey,
      message: `已记录指令（${issueKey}），下一轮将由 AI 重新评估是否继续处理。`
    };
  }

  private async resolveIssueKeyFromSlackRootMessage(threadToken: string): Promise<string> {
    const parsedThread = parseSlackThreadToken(threadToken);
    if (!parsedThread) {
      return "";
    }

    const config = await this.configStore.load();
    const token = resolveSlackCredential(config, "botToken");
    if (!token) {
      return "";
    }

    try {
      const client = new WebClient(token);
      const response = await client.conversations.replies({
        channel: parsedThread.channelId,
        ts: parsedThread.threadTs,
        inclusive: true,
        limit: 1
      });
      const first = Array.isArray(response.messages) ? response.messages[0] : undefined;
      const text = String(first?.text || "").trim();
      if (!text) {
        return "";
      }

      const fromUrl = extractIssueRefFromText(text);
      if (fromUrl) {
        const key = `${fromUrl.owner}/${fromUrl.repo}#${fromUrl.issueNumber}`;
        const matched = config.repositories.find(
          (repo) =>
            repo.enabled &&
            repo.owner === fromUrl.owner &&
            repo.repo === fromUrl.repo
        );
        if (matched) {
          return key;
        }
      }

      const numberMatch = text.match(/\bissue\s*#(\d+)\b/i);
      if (!numberMatch) {
        return "";
      }
      const issueNumber = Number(numberMatch[1]);
      if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
        return "";
      }

      const matchedByChannel = config.repositories.filter(
        (repo) =>
          repo.enabled &&
          repo.slack.enabled &&
          String(repo.slack.channelId || "").trim() === parsedThread.channelId
      );
      if (matchedByChannel.length !== 1) {
        return "";
      }
      const repo = matchedByChannel[0];
      return `${repo.owner}/${repo.repo}#${issueNumber}`;
    } catch {
      return "";
    }
  }

  private async recoverRecordForSlackSignal(
    issueKey: string,
    threadToken: string
  ): Promise<IssueExecutionRecord | null> {
    const parsedIssue = parseIssueKeyStrict(issueKey);
    if (!parsedIssue) {
      return null;
    }

    const config = await this.configStore.load();
    const repo = config.repositories.find(
      (item) =>
        item.enabled &&
        item.owner === parsedIssue.owner &&
        item.repo === parsedIssue.repo
    );
    if (!repo) {
      return null;
    }

    const now = new Date().toISOString();
    const parsedThread = parseSlackThreadToken(threadToken);
    const normalizedThreadToken = parsedThread
      ? `slack:${parsedThread.channelId}:${parsedThread.threadTs}`
      : String(threadToken || "").trim();
    const recoveredSessionId = await this.loadCodexSessionIdFromChannelSessions(threadToken);

    const fallbackRecord: IssueExecutionRecord = {
      issueKey,
      repoId: repo.id,
      issueNumber: parsedIssue.issueNumber,
      state: "failed",
      summary: "Recovered runtime record from Slack thread binding",
      prUrl: "",
      rootCause: "",
      solution: "",
      closedAt: "",
      threadTs: normalizedThreadToken,
      lastExternalCommentId: 0,
      lastExternalCommentAt: "",
      lastSlackSignalAt: "",
      lastHandledSlackSignalAt: "",
      lastSlackSignalText: "",
      codexSessionId: recoveredSessionId,
      triageSessionId: recoveredSessionId,
      implementSessionId: recoveredSessionId,
      lastTriggerType: "slack_signal",
      updatedAt: now
    };

    await this.runtimeStore.markSeen(issueKey);
    await this.runtimeStore.saveRecord(fallbackRecord);
    return fallbackRecord;
  }

  private async loadCodexSessionIdFromChannelSessions(threadToken: string): Promise<string> {
    try {
      const raw = await readFile(this.paths.channelSessionFile, "utf8");
      const parsed = JSON.parse(raw) as {
        sessions?: Array<{ threadId?: string; codexSessionId?: string }>;
      };
      const sessions = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      const aliases = deriveThreadTokenAliases(threadToken);
      for (const session of sessions) {
        const candidateThread = String(session.threadId || "").trim();
        if (!candidateThread) {
          continue;
        }
        const candidateAliases = deriveThreadTokenAliases(candidateThread);
        if (!aliases.some((alias) => candidateAliases.includes(alias))) {
          continue;
        }
        return String(session.codexSessionId || "").trim();
      }
      return "";
    } catch {
      return "";
    }
  }

  private async handleSlackChannelMessage(input: {
    threadId: string;
    channelId: string;
    text: string;
    isMention: boolean;
    post: (text: string) => Promise<void>;
  }): Promise<ChannelMessageResult> {
    let repoIdHint = "";
    let codexSessionIdHint = "";
    let issueKeyHint = "";

    const issueKey = await this.resolveIssueKeyByThreadToken(input.threadId);
    if (issueKey) {
      issueKeyHint = issueKey;
      const record = await this.runtimeStore.getRecord(issueKey);
      if (record) {
        repoIdHint = String(record.repoId || "").trim();
        codexSessionIdHint = String(
          record.codexSessionId || record.implementSessionId || record.triageSessionId || ""
        ).trim();
      } else {
        const parsed = parseIssueKeyStrict(issueKey);
        if (parsed) {
          const config = await this.configStore.load();
          const repo = config.repositories.find(
            (item) => item.enabled && item.owner === parsed.owner && item.repo === parsed.repo
          );
          if (repo) {
            repoIdHint = repo.id;
          }
        }
      }
    }

    const result = await this.slackChannelCodexManager.handleMessage({
      threadId: input.threadId,
      channelId: input.channelId,
      text: input.text,
      isMention: input.isMention,
      post: input.post,
      repoIdHint,
      codexSessionIdHint,
      issueKeyHint
    });
    return result;
  }

  private async dispatchWorker(task: WorkerTask): Promise<void> {
    const nowIso = new Date().toISOString();
    const activeWorker = this.workersByIssueKey.get(task.issueKey);
    if (activeWorker) {
      activeWorker.lastMessageAtMs = Date.now();
      activeWorker.lastHeartbeatAtMs = Date.now();
      const activeRecord = await this.runtimeStore.getRecord(task.issueKey);
      if (activeRecord) {
        await this.runtimeStore.saveRecord({
          ...activeRecord,
          lastWorkerHeartbeatAt: nowIso,
          lastTriggerType: task.triggerType
        });
      }
      return;
    }

    const preDispatchRecord = await this.runtimeStore.getRecord(task.issueKey);
    if (preDispatchRecord) {
      await this.runtimeStore.saveRecord({
        ...preDispatchRecord,
        lastWorkerHeartbeatAt: nowIso,
        lastTriggerType: task.triggerType
      });
    }

    const command = resolveWorkerCommand();
    const child = spawn(command.bin, [...command.args, ...buildWorkerArgs(this.configStore.resolvedPath(), task)], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        ISSUE_HUNTER_WORKER: "1"
      },
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"]
    });

    const worker: RunningWorker = {
      child,
      issueKey: task.issueKey,
      repoId: task.repo.id,
      issueNumber: task.issueNumber,
      startedAt: new Date().toISOString(),
      threadTokens: new Set<string>(),
      lastHeartbeatAtMs: Date.now(),
      lastMessageAtMs: Date.now(),
      forcedTerminationReason: ""
    };

    this.workersByIssueKey.set(task.issueKey, worker);
    child.unref();

    child.on("message", (message: WorkerMessage) => {
      void this.handleWorkerMessage(worker, message);
    });

    child.on("error", (error) => {
      void this.handleWorkerExit(worker, 1, `spawn-error:${error instanceof Error ? error.message : String(error)}`);
    });

    child.on("exit", (code, signal) => {
      void this.handleWorkerExit(worker, code ?? 1, signal ?? "");
    });

    await this.configStore.updateServiceState({
      activeTasks: this.workersByIssueKey.size,
      running: Boolean(this.timer)
    });
  }

  private async handleWorkerMessage(worker: RunningWorker, message: WorkerMessage): Promise<void> {
    if (!message || typeof message !== "object") {
      return;
    }
    worker.lastMessageAtMs = Date.now();

    const type = String(message.type || "");
    if (type === "thread_registered") {
      const token = String(message.threadToken || "").trim();
      if (!token) {
        return;
      }
      for (const alias of deriveThreadTokenAliases(token)) {
        worker.threadTokens.add(alias);
        this.issueKeyByThreadToken.set(alias, worker.issueKey);
      }
      return;
    }

    if (type === "thread_unregistered") {
      this.unregisterThreadAliases(worker);
      return;
    }

    if (type === "failed") {
      const detail = String(message.message || "Worker execution failed").trim();
      await this.markIssueFailedIfNeeded(worker, detail, classifyServiceFailure(detail));
      this.status.lastError = detail;
      await this.configStore.updateServiceState({
        lastError: detail,
        lastRunAt: new Date().toISOString(),
        running: Boolean(this.timer)
      });
      return;
    }

    if (type === "stop_ack") {
      // Informational only. The worker will eventually exit and update runtime state.
      return;
    }

    if (type === "heartbeat") {
      const atRaw = String(message.at || "").trim();
      const atMs = Date.parse(atRaw);
      const atIso = Number.isFinite(atMs) ? new Date(atMs).toISOString() : new Date().toISOString();
      worker.lastHeartbeatAtMs = Date.parse(atIso);
      const current = await this.runtimeStore.getRecord(worker.issueKey);
      if (current) {
        await this.runtimeStore.saveRecord({
          ...current,
          lastWorkerHeartbeatAt: atIso
        });
      }
      return;
    }
  }

  private unregisterThreadAliases(worker: RunningWorker): void {
    for (const token of worker.threadTokens) {
      this.issueKeyByThreadToken.delete(token);
    }
    worker.threadTokens.clear();
  }

  private async handleWorkerExit(worker: RunningWorker, code: number, signal: string): Promise<void> {
    if (!this.workersByIssueKey.has(worker.issueKey)) {
      return;
    }

    this.workersByIssueKey.delete(worker.issueKey);
    this.unregisterThreadAliases(worker);

    const forcedTermination = Boolean(String(worker.forcedTerminationReason || "").trim());
    if ((code !== 0 && code !== 130) || forcedTermination) {
      this.workerFailures += 1;
      const detail =
        String(worker.forcedTerminationReason || "").trim() ||
        `Issue worker exited unexpectedly (${worker.issueKey}, code=${code}, signal=${signal || "none"})`;
      await this.markIssueFailedIfNeeded(
        worker,
        detail,
        worker.forcedTerminationReason
          ? { category: "transient", retryEligible: true }
          : classifyServiceFailure(detail)
      );
      this.status.lastError = detail;
      await this.configStore.updateServiceState({
        lastError: detail,
        lastRunAt: new Date().toISOString(),
        running: Boolean(this.timer)
      });
    }

    this.status.activeTasks = this.workersByIssueKey.size;
    await this.configStore.updateServiceState({
      activeTasks: this.workersByIssueKey.size,
      running: Boolean(this.timer)
    });
  }

  private async markIssueFailedIfNeeded(
    worker: RunningWorker,
    detail: string,
    failure?: { category: "transient" | "logic" | "config" | "cancelled" | "unknown"; retryEligible: boolean }
  ): Promise<void> {
    const current = await this.runtimeStore.getRecord(worker.issueKey);
    if (current && (current.state === "completed" || current.state === "ignored" || current.state === "failed")) {
      return;
    }

    const fallbackRecord: IssueExecutionRecord = {
      issueKey: worker.issueKey,
      repoId: worker.repoId,
      issueNumber: worker.issueNumber,
      state: "failed",
      summary: detail,
      prUrl: "",
      rootCause: "",
      solution: "",
      closedAt: "",
      threadTs: current?.threadTs || "",
      failureCategory: failure?.category,
      failureRetryEligible: failure?.retryEligible,
      updatedAt: new Date().toISOString()
    };

    if (current) {
      await this.runtimeStore.saveRecord({
        ...current,
        state: "failed",
        summary: current.summary || detail,
        failureCategory: current.failureCategory || failure?.category,
        failureRetryEligible:
          typeof current.failureRetryEligible === "boolean" ? current.failureRetryEligible : failure?.retryEligible,
        updatedAt: fallbackRecord.updatedAt
      });
      return;
    }

    await this.runtimeStore.saveRecord(fallbackRecord);
  }
}

function parseIssueKey(issueKey: string, fallbackIssueNumber: number): { repoFullName: string; issueNumber: number } {
  const text = String(issueKey || "").trim();
  const match = text.match(/^([^#]+)#(\d+)$/);
  if (!match) {
    return {
      repoFullName: "unknown/unknown",
      issueNumber: fallbackIssueNumber
    };
  }

  return {
    repoFullName: match[1],
    issueNumber: Number(match[2]) || fallbackIssueNumber
  };
}

function parseRegressionCaseFilename(fileName: string): { repoId: string; issueNumber: number } | null {
  const text = String(fileName || "").trim();
  const match = text.match(/^(.+)-issue-(\d+)\.md$/);
  if (!match) {
    return null;
  }

  const issueNumber = Number(match[2]);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    return null;
  }

  return {
    repoId: String(match[1] || "").trim(),
    issueNumber
  };
}

function parseRegressionCaseMarkdown(content: string): {
  repoFullName: string;
  summary: string;
  rootCause: string;
  solution: string;
  prUrl: string;
} {
  const text = String(content || "");
  const titleMatch = text.match(/^#\s+Regression Case - ([^#\s]+#[0-9]+)\s*$/m);
  const summary = extractMarkdownSection(text, "Summary");
  const rootCause = extractMarkdownSection(text, "RootCause");
  const solution = extractMarkdownSection(text, "Solution");
  const prRaw = extractMarkdownSection(text, "PR");
  const prUrl = extractFirstHttpUrl(prRaw || text);
  const issueRef = titleMatch ? parseIssueKeyStrict(titleMatch[1]) : null;
  const repoFullName = issueRef ? `${issueRef.owner}/${issueRef.repo}` : "";

  return {
    repoFullName,
    summary: summary || "",
    rootCause: rootCause || "",
    solution: solution || "",
    prUrl
  };
}

function extractMarkdownSection(text: string, heading: string): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=^##\\s+|$)`, "m");
  const match = text.match(pattern);
  return String(match?.[1] || "").trim();
}

function extractFirstHttpUrl(text: string): string {
  const match = String(text || "").match(/https?:\/\/[^\s)]+/);
  return String(match?.[0] || "").trim();
}

function isBoardVisibleState(state: IssueExecutionRecord["state"]): boolean {
  return (
    state === "triaging" ||
    state === "awaiting_approval" ||
    state === "scheduled" ||
    state === "implementing" ||
    state === "completed"
  );
}

function boardStateWeight(state: IssueExecutionRecord["state"]): number {
  if (state === "triaging" || state === "awaiting_approval" || state === "scheduled" || state === "implementing") {
    return 0;
  }
  if (state === "completed") {
    return 1;
  }
  return 2;
}

function parseIssueKeyStrict(issueKey: string): { owner: string; repo: string; issueNumber: number } | null {
  const text = String(issueKey || "").trim();
  const match = text.match(/^([^/#\s]+)\/([^#\s]+)#(\d+)$/);
  if (!match) {
    return null;
  }
  const issueNumber = Number(match[3]);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    return null;
  }
  return {
    owner: match[1],
    repo: match[2],
    issueNumber
  };
}

function resolveWorkerCommand(): { bin: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  const currentExt = extname(currentFile);
  const rootDir = resolve(dirname(currentFile), "..");

  if (currentExt === ".ts") {
    const workerTs = resolve(rootDir, "worker", "issue-worker.ts");
    return {
      bin: process.env.ISSUE_HUNTER_TSX_BIN || "tsx",
      args: [workerTs]
    };
  }

  const workerJs = resolve(rootDir, "worker", "issue-worker.js");
  return {
    bin: process.execPath,
    args: [workerJs]
  };
}

function buildWorkerArgs(configPath: string, task: WorkerTask): string[] {
  return [
    "--config",
    configPath,
    "--repo-id",
    task.repo.id,
    "--issue-number",
    String(task.issueNumber),
    "--issue-key",
    task.issueKey,
    "--trigger-type",
    task.triggerType
  ];
}

function deriveThreadTokenAliases(token: string): string[] {
  const raw = String(token || "").trim();
  if (!raw) {
    return [];
  }

  const aliases = new Set<string>([raw]);
  if (raw.startsWith("slack:")) {
    const parts = raw.split(":");
    if (parts.length >= 3) {
      const threadTs = parts.slice(2).join(":").trim();
      if (threadTs) {
        aliases.add(threadTs);
      }
      if (parts[1] && threadTs) {
        aliases.add(`slack:${parts[1]}:${threadTs}`);
      }
    }
  }

  return [...aliases];
}

function parseSlackThreadToken(threadToken: string): { channelId: string; threadTs: string } | null {
  const raw = String(threadToken || "").trim();
  if (!raw) {
    return null;
  }
  const normalized = raw.startsWith("slack:") ? raw : `slack::${raw}`;
  const parts = normalized.split(":");
  if (parts.length < 3) {
    return null;
  }
  const channelId = String(parts[1] || "").trim();
  const threadTs = String(parts.slice(2).join(":") || "").trim();
  if (!threadTs) {
    return null;
  }
  if (!channelId) {
    return null;
  }
  return { channelId, threadTs };
}

function extractIssueRefFromText(text: string): { owner: string; repo: string; issueNumber: number } | null {
  const value = String(text || "");
  const urlMatch = value.match(
    /https?:\/\/github\.com\/([^/\s>]+)\/([^/\s>]+)\/issues\/(\d+)/i
  );
  if (!urlMatch) {
    return null;
  }
  const issueNumber = Number(urlMatch[3]);
  if (!Number.isFinite(issueNumber) || issueNumber <= 0) {
    return null;
  }
  return {
    owner: urlMatch[1],
    repo: urlMatch[2],
    issueNumber
  };
}

function resolveSlackCredential(
  config: AppConfig,
  key: "botToken" | "appToken" | "signingSecret" | "clientId" | "clientSecret"
): string {
  const directValue = config.slackApp[key];
  if (directValue && directValue.trim()) {
    return directValue.trim();
  }

  const envKeyMap: Record<typeof key, string> = {
    botToken: config.slackApp.botTokenEnv,
    appToken: config.slackApp.appTokenEnv,
    signingSecret: config.slackApp.signingSecretEnv,
    clientId: config.slackApp.clientIdEnv,
    clientSecret: config.slackApp.clientSecretEnv
  };

  const envName = envKeyMap[key];
  if (!envName) {
    return "";
  }

  return process.env[envName] ?? "";
}

function getWorkerHeartbeatTimeoutSeconds(): number {
  return Math.max(60, Number(process.env.ISSUE_HUNTER_WORKER_HEARTBEAT_TIMEOUT_SECONDS || 900));
}

function classifyServiceFailure(message: string): {
  category: "transient" | "logic" | "config" | "cancelled" | "unknown";
  retryEligible: boolean;
} {
  const text = String(message || "").toLowerCase();
  if (!text) {
    return { category: "unknown", retryEligible: false };
  }

  if (
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("econnreset") ||
    text.includes("connection reset") ||
    text.includes("tls handshake") ||
    text.includes("socket hang up") ||
    text.includes("http 502") ||
    text.includes("http 503") ||
    text.includes("http 504")
  ) {
    return { category: "transient", retryEligible: true };
  }

  if (
    text.includes("not authenticated") ||
    text.includes("invalid token") ||
    text.includes("forbidden") ||
    text.includes("permission denied") ||
    text.includes("gh auth status")
  ) {
    return { category: "config", retryEligible: false };
  }

  if (text.includes("cancelled by stop request") || text.includes("cancelled by stop command")) {
    return { category: "cancelled", retryEligible: false };
  }

  if (text.includes("cannot parse") || text.includes("json") || text.includes("workflow violation")) {
    return { category: "logic", retryEligible: false };
  }

  return { category: "unknown", retryEligible: false };
}

// Worker-side helper for consistency between scheduler and worker implementations.
export function createNotifierFactory(configStore: ConfigStore, chatBridge: ChatSlackBridge) {
  return (repo: RepositoryConfig) => {
    if (!repo.slack.enabled || !repo.slack.channelId) {
      return null;
    }

    if (repo.slack.transport === "chat_sdk") {
      return new ChatSdkNotifier(chatBridge, repo.slack.channelId);
    }

    if (repo.slack.transport === "slack_sdk") {
      const configPromise = configStore.load();
      return {
        postIssueStart: async (issue: Record<string, unknown>) => {
          const loaded = await configPromise;
          const token = resolveSlackCredential(loaded, "botToken");
          if (!token) {
            throw new Error(
              `Missing Slack bot token. Fill Slack Bot Token in UI or set env ${loaded.slackApp.botTokenEnv}.`
            );
          }
          const notifier = new DirectSlackNotifier(token, repo.slack.channelId);
          return notifier.postIssueStart(issue);
        },
        postThreadUpdate: async (threadToken: string, text: string) => {
          const loaded = await configPromise;
          const token = resolveSlackCredential(loaded, "botToken");
          if (!token) {
            throw new Error(
              `Missing Slack bot token. Fill Slack Bot Token in UI or set env ${loaded.slackApp.botTokenEnv}.`
            );
          }
          const notifier = new DirectSlackNotifier(token, repo.slack.channelId);
          return notifier.postThreadUpdate(threadToken, text);
        }
      };
    }

    return null;
  };
}

// Worker-side helper for context/worktree preparation.
export async function prepareWorkspaceWithConfig(
  configStore: ConfigStore,
  repo: RepositoryConfig,
  issue: Record<string, unknown>,
  comments: Record<string, unknown>[],
  imageUrls: string[]
) {
  const config = await configStore.load();
  const workspaceRoot = resolve(config.global.workspaceDir || ".");
  await mkdir(workspaceRoot, { recursive: true });
  const manager = new WorkspaceManager({
    workspaceRoot,
    keepWorktrees: config.global.keepWorktrees
  });
  const github = new GhCliClient({
    owner: repo.owner,
    repo: repo.repo,
    localPath: repo.localPath
  });
  return manager.prepare(repo, issue, comments, imageUrls, github);
}

export async function writeRegressionCaseWithRuntime(
  regressionDir: string,
  repo: RepositoryConfig,
  issueNumber: number,
  issueTitle: string,
  result: Record<string, unknown>
): Promise<void> {
  await writeRegressionCase(regressionDir, repo, issueNumber, issueTitle, result);
}
