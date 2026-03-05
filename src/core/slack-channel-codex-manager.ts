import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants as fsConstants, existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";

import type { AppConfig, RepositoryConfig } from "../types/config.js";
import type { AgentBackend } from "../types/config.js";
import { resolveAgentBinary } from "../clients/agent-detect.js";
import { WorktreeManager } from "./worktree-manager.js";
import type { ConfigStore } from "./config-store.js";
import { runCommand, type CommandResult } from "../utils/run-command.js";

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string }
) => Promise<CommandResult>;

interface ChannelSession {
  threadId: string;
  repoId: string;
  channelId: string;
  issueKey: string;
  worktreePath: string;
  worktreeBranch: string;
  codexSessionId: string;
  updatedAt: string;
}

interface SessionSnapshot {
  sessions: ChannelSession[];
  updatedAt: string;
}

export interface ChannelMessageInput {
  threadId: string;
  channelId: string;
  text: string;
  isMention: boolean;
  post: (text: string) => Promise<void>;
  repoIdHint?: string;
  codexSessionIdHint?: string;
  issueKeyHint?: string;
  issueWorktreePathHint?: string;
  issueWorktreeBranchHint?: string;
}

export interface ChannelMessageResult {
  accepted: boolean;
  message: string;
}

export interface StopResult {
  stopped: boolean;
  issueKey: string;
  message: string;
}

export class SlackChannelCodexManager {
  private readonly worktreeManager = new WorktreeManager();
  private readonly sessions = new Map<string, ChannelSession>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly runningByThread = new Map<string, ChildProcess>();
  private readonly pendingByThread = new Map<string, number>();
  private sessionsLoaded = false;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly sessionFilePath: string,
    private readonly commandRunner: CommandRunner = runCommand,
    private readonly codexBin: string = ""
  ) {}

  async handleMessage(input: ChannelMessageInput): Promise<ChannelMessageResult> {
    await this.ensureLoaded();
    const text = String(input.text || "").trim();
    if (!text) {
      return { accepted: false, message: "" };
    }

    const config = await this.configStore.load();
    const existing = this.sessions.get(input.threadId);
    const issueKeyHint = String(input.issueKeyHint || "").trim();
    if (existing) {
      const boundIssueKey = String(existing.issueKey || "").trim();
      if (boundIssueKey && issueKeyHint && boundIssueKey !== issueKeyHint) {
        return {
          accepted: true,
          message: `当前 thread 已绑定 ${boundIssueKey}，拒绝切换到 ${issueKeyHint}。请在原 issue 线程继续。`
        };
      }
    }
    const repo = existing
      ? findRepoById(config, existing.repoId)
      : input.repoIdHint
        ? findRepoById(config, input.repoIdHint)
        : findRepoBySlackChannel(config, input.channelId);

    // eslint-disable-next-line no-console
    console.info(
      `[issue-hunter][channel_codex] inbound thread=${input.threadId} channel=${input.channelId} ` +
        `existing_session=${existing?.codexSessionId || "-"} existing_issue=${existing?.issueKey || "-"} ` +
        `hint_repo=${input.repoIdHint || "-"} hint_issue=${issueKeyHint || "-"} hint_session=${input.codexSessionIdHint || "-"} ` +
        `resolved_repo=${repo ? `${repo.owner}/${repo.repo}` : "-"} text="${truncate(text, 180)}"`
    );

    if (!repo) {
      return { accepted: false, message: "" };
    }

    const pendingCount = this.pendingByThread.get(input.threadId) || 0;
    const wasBusy = pendingCount > 0 || this.runningByThread.has(input.threadId) || this.queues.has(input.threadId);
    const sessionHint = String(existing?.codexSessionId || input.codexSessionIdHint || "").trim();
    const enqueuePromise = this.enqueue(input.threadId, async () => {
      await this.runCodexForMessage(repo, input, config.global.agentBackend);
    });
    void enqueuePromise;

    return {
      accepted: true,
      message: wasBusy
        ? `已收到，已加入当前 thread 队列（仓库: ${repo.owner}/${repo.repo}）。${formatSessionAckMessage(sessionHint)}`
        : `已收到，开始在仓库 ${repo.owner}/${repo.repo} 处理中。${formatSessionAckMessage(sessionHint)}`
    };
  }

  async stopByThread(threadToken: string): Promise<StopResult> {
    await this.ensureLoaded();
    const aliases = deriveThreadTokenAliases(threadToken);
    const targetThread = [...this.runningByThread.keys()].find((threadId) => {
      const threadAliases = deriveThreadTokenAliases(threadId);
      return aliases.some((alias) => threadAliases.includes(alias));
    });

    if (!targetThread) {
      return {
        stopped: false,
        issueKey: "",
        message: "当前 thread 没有关联运行中的频道 Codex 任务。"
      };
    }

    const child = this.runningByThread.get(targetThread);
    if (!child) {
      return {
        stopped: false,
        issueKey: "",
        message: "当前 thread 没有关联运行中的频道 Codex 任务。"
      };
    }

    try {
      const session = this.sessions.get(targetThread);
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          if (!child.killed) {
            child.kill("SIGKILL");
          }
        } catch {
          // Ignore kill escalation errors.
        }
      }, 5000);
      return {
        stopped: true,
        issueKey: String(session?.issueKey || ""),
        message: "已停止当前 thread 的频道 Codex 任务。"
      };
    } catch (error) {
      return {
        stopped: false,
        issueKey: "",
        message: `停止频道 Codex 任务失败: ${error instanceof Error ? error.message : String(error)}`
      };
    }
  }

  getLoadSnapshot(): { runningTasks: number; queuedTasks: number } {
    let queuedTasks = 0;
    for (const [threadId, pendingCount] of this.pendingByThread.entries()) {
      const normalizedPending = Math.max(0, Number(pendingCount) || 0);
      if (normalizedPending <= 0) {
        continue;
      }
      const running = this.runningByThread.has(threadId) ? 1 : 0;
      queuedTasks += Math.max(0, normalizedPending - running);
    }
    return {
      runningTasks: this.runningByThread.size,
      queuedTasks
    };
  }

  private async enqueue(threadId: string, task: () => Promise<void>): Promise<void> {
    this.pendingByThread.set(threadId, (this.pendingByThread.get(threadId) || 0) + 1);
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.warn(
          `[issue-hunter][channel_codex] queued task failed thread=${threadId} detail="${truncate(
            error instanceof Error ? error.message : String(error),
            220
          )}"`
        );
      })
      .finally(() => {
        const pending = Math.max(0, (this.pendingByThread.get(threadId) || 1) - 1);
        if (pending > 0) {
          this.pendingByThread.set(threadId, pending);
        } else {
          this.pendingByThread.delete(threadId);
        }
        if (this.queues.get(threadId) === next) {
          this.queues.delete(threadId);
        }
      });
    this.queues.set(threadId, next);
    await next;
  }

  private async runCodexForMessage(
    repo: RepositoryConfig,
    input: ChannelMessageInput,
    backend: AgentBackend
  ): Promise<void> {
    const session = await this.getOrCreateSession(
      repo,
      input.threadId,
      input.channelId,
      String(input.codexSessionIdHint || "").trim(),
      String(input.issueKeyHint || "").trim(),
      String(input.issueWorktreePathHint || "").trim(),
      String(input.issueWorktreeBranchHint || "").trim()
    );
    await this.recoverSessionWorktreeIfMissing(
      repo,
      session,
      String(input.issueWorktreePathHint || "").trim(),
      String(input.issueWorktreeBranchHint || "").trim()
    );
    const batchIntervalMs =
      Math.max(5, Number(process.env.ISSUE_HUNTER_SLACK_BATCH_INTERVAL_SECONDS || 45)) * 1000;
    const postBatcher = createPostBatcher(input.post, batchIntervalMs);
    const command = buildCodexCommand(
      this.codexBin,
      backend,
      session.worktreePath,
      session.codexSessionId,
      input.text
    );
    // eslint-disable-next-line no-console
    console.info(
      `[issue-hunter][channel_codex] start thread=${input.threadId} issue=${session.issueKey || "-"} repo=${repo.owner}/${repo.repo} ` +
        `session=${session.codexSessionId || "-"} worktree=${session.worktreePath} branch=${session.worktreeBranch} bin=${command.bin}`
    );
    let child: ChildProcess;
    try {
      child = spawn(command.bin, command.args, {
        cwd: session.worktreePath,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      const detail = formatLaunchFailure(error, command.bin, session.worktreePath);
      // eslint-disable-next-line no-console
      console.warn(
        `[issue-hunter][channel_codex] spawn_failed thread=${input.threadId} issue=${session.issueKey || "-"} ` +
          `session=${session.codexSessionId || "-"} detail="${truncate(detail, 220)}"`
      );
      await postBatcher.push(`处理失败: ${detail}`, { immediate: true });
      await postBatcher.stop();
      return;
    }
    this.runningByThread.set(input.threadId, child);

    let stdout = "";
    let stderr = "";
    let lineBuffer = "";
    let lastAssistantMessage = "";
    let sessionId = session.codexSessionId;

    const consumeLine = async (lineRaw: string) => {
      const line = String(lineRaw || "").trim();
      if (!line) {
        return;
      }

      let event: Record<string, unknown> | null = null;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }

      const eventType = String(event.type || "");
      if (eventType === "thread.started") {
        const startedId = String(event.thread_id ?? event.threadId ?? "").trim();
        if (startedId) {
          sessionId = startedId;
          await postBatcher.push(`System: Codex 会话已启动 (session: ${startedId})`, {
            immediate: true
          });
        }
        return;
      }

      if (eventType !== "item.completed") {
        return;
      }

      const item = (event.item ?? {}) as Record<string, unknown>;
      const itemType = String(item.type ?? "");
      if (itemType === "reasoning") {
        const reasoning = String(item.text ?? "").trim();
        if (reasoning) {
          await postBatcher.push(`Assistant: 🧠 ${truncate(reasoning, 300)}`);
        }
        return;
      }

      if (itemType === "agent_message") {
        const text = String(item.text ?? "").trim();
        if (!text) {
          return;
        }
        lastAssistantMessage = text;
      }
    };

    try {
      const stdoutStream = child.stdout;
      if (stdoutStream) {
        stdoutStream.on("data", (chunk) => {
          const text = chunk.toString();
          stdout += text;
          lineBuffer += text;
          let idx = lineBuffer.indexOf("\n");
          while (idx >= 0) {
            const line = lineBuffer.slice(0, idx);
            lineBuffer = lineBuffer.slice(idx + 1);
            void consumeLine(line);
            idx = lineBuffer.indexOf("\n");
          }
        });
      }

      const stderrStream = child.stderr;
      if (stderrStream) {
        stderrStream.on("data", (chunk) => {
          stderr += chunk.toString();
        });
      }

      const code = await new Promise<number>((resolve, reject) => {
        child.on("error", (error) => {
          reject(error);
        });
        child.on("close", (exitCode) => {
          resolve(exitCode ?? 1);
        });
      });

      if (lineBuffer.trim()) {
        await consumeLine(lineBuffer);
      }

      if (sessionId && sessionId !== session.codexSessionId) {
        session.codexSessionId = sessionId;
        session.updatedAt = new Date().toISOString();
        this.sessions.set(input.threadId, session);
        await this.persistSessions();
        // eslint-disable-next-line no-console
        console.info(
          `[issue-hunter][channel_codex] session_updated thread=${input.threadId} issue=${session.issueKey || "-"} ` +
            `session=${session.codexSessionId}`
        );
      }

      if (code !== 0) {
        const detail = truncate(stderr || stdout || `exit=${code}`, 1200);
        // eslint-disable-next-line no-console
        console.warn(
          `[issue-hunter][channel_codex] failed thread=${input.threadId} issue=${session.issueKey || "-"} ` +
            `session=${session.codexSessionId || "-"} exit=${code} detail="${truncate(detail, 220)}"`
        );
        await postBatcher.push(`处理失败: ${detail}`, { immediate: true });
        return;
      }

      const finalText = lastAssistantMessage || extractLastNonEmptyLine(stdout) || "已完成，但未捕获可展示输出。";
      // eslint-disable-next-line no-console
      console.info(
        `[issue-hunter][channel_codex] done thread=${input.threadId} issue=${session.issueKey || "-"} ` +
          `session=${session.codexSessionId || "-"} final_preview="${truncate(finalText, 220)}"`
      );
      await postBatcher.push(finalText, { immediate: true });
    } catch (error) {
      const detail = formatLaunchFailure(error, command.bin, session.worktreePath);
      // eslint-disable-next-line no-console
      console.warn(
        `[issue-hunter][channel_codex] runtime_failed thread=${input.threadId} issue=${session.issueKey || "-"} ` +
          `session=${session.codexSessionId || "-"} detail="${truncate(detail, 220)}"`
      );
      await postBatcher.push(`处理失败: ${detail}`, { immediate: true });
    } finally {
      this.runningByThread.delete(input.threadId);
      await postBatcher.stop();
    }
  }

  private async recoverSessionWorktreeIfMissing(
    repo: RepositoryConfig,
    session: ChannelSession,
    issueWorktreePathHint: string,
    issueWorktreeBranchHint: string
  ): Promise<void> {
    if (await isExistingDirectory(session.worktreePath)) {
      return;
    }

    const hintedPath = String(issueWorktreePathHint || "").trim();
    if (hintedPath && (await isExistingDirectory(hintedPath))) {
      session.worktreePath = hintedPath;
      if (String(issueWorktreeBranchHint || "").trim()) {
        session.worktreeBranch = String(issueWorktreeBranchHint || "").trim();
      }
      session.updatedAt = new Date().toISOString();
      this.sessions.set(session.threadId, session);
      await this.persistSessions();
      // eslint-disable-next-line no-console
      console.info(
        `[issue-hunter][channel_codex] recover_worktree thread=${session.threadId} issue=${session.issueKey || "-"} ` +
          `mode=hint worktree=${session.worktreePath} branch=${session.worktreeBranch}`
      );
      return;
    }

    const issueNumber = extractIssueNumberFromKey(session.issueKey) || Date.now();
    const plan = this.worktreeManager.plan(repo.localPath, repo.id, issueNumber);
    const addResult = await this.commandRunner(
      "git",
      ["-C", repo.localPath, "worktree", "add", "-b", plan.branch, plan.path, "HEAD"],
      { cwd: repo.localPath }
    );
    if (addResult.code !== 0) {
      throw new Error(
        `恢复 worktree 失败: ${addResult.stderr || addResult.stdout || `git exit ${addResult.code}`}`
      );
    }

    session.worktreePath = plan.path;
    session.worktreeBranch = plan.branch;
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.threadId, session);
    await this.persistSessions();
    // eslint-disable-next-line no-console
    console.info(
      `[issue-hunter][channel_codex] recover_worktree thread=${session.threadId} issue=${session.issueKey || "-"} ` +
        `mode=recreate worktree=${session.worktreePath} branch=${session.worktreeBranch}`
    );
  }

  private async getOrCreateSession(
    repo: RepositoryConfig,
    threadId: string,
    channelId: string,
    codexSessionIdHint: string,
    issueKeyHint: string,
    issueWorktreePathHint: string,
    issueWorktreeBranchHint: string
  ): Promise<ChannelSession> {
    const existing = this.sessions.get(threadId);
    if (existing && existing.repoId === repo.id) {
      const normalizedIssueKeyHint = String(issueKeyHint || "").trim();
      const boundIssueKey = String(existing.issueKey || "").trim();
      if (boundIssueKey && normalizedIssueKeyHint && boundIssueKey !== normalizedIssueKeyHint) {
        throw new Error(`Thread ${threadId} is already bound to ${boundIssueKey}; cannot switch to ${normalizedIssueKeyHint}`);
      }
      const hint = String(codexSessionIdHint || "").trim();
      const hintWorktreePath = String(issueWorktreePathHint || "").trim();
      const hintWorktreeBranch = String(issueWorktreeBranchHint || "").trim();
      const canRebindIssueWorktree =
        Boolean(hintWorktreePath) &&
        Boolean(normalizedIssueKeyHint) &&
        (!boundIssueKey || boundIssueKey === normalizedIssueKeyHint) &&
        existing.worktreePath !== hintWorktreePath &&
        (await isExistingDirectory(hintWorktreePath));
      const shouldPersist =
        (!existing.codexSessionId && Boolean(hint)) ||
        (!boundIssueKey && Boolean(normalizedIssueKeyHint)) ||
        canRebindIssueWorktree;
      if (hint && !existing.codexSessionId) {
        existing.codexSessionId = hint;
      }
      if (!boundIssueKey && normalizedIssueKeyHint) {
        existing.issueKey = normalizedIssueKeyHint;
      }
      if (canRebindIssueWorktree) {
        existing.worktreePath = hintWorktreePath;
        if (hintWorktreeBranch) {
          existing.worktreeBranch = hintWorktreeBranch;
        }
      }
      if (shouldPersist) {
        existing.updatedAt = new Date().toISOString();
        this.sessions.set(threadId, existing);
        await this.persistSessions();
        // eslint-disable-next-line no-console
        console.info(
          `[issue-hunter][channel_codex] rebind thread=${threadId} issue=${existing.issueKey || "-"} ` +
            `session=${existing.codexSessionId || "-"} worktree=${existing.worktreePath} branch=${existing.worktreeBranch}`
        );
      }
      return existing;
    }

    let worktreePath = "";
    let worktreeBranch = "";
    const hintedWorktreePath = String(issueWorktreePathHint || "").trim();
    if (hintedWorktreePath && (await isExistingDirectory(hintedWorktreePath))) {
      worktreePath = hintedWorktreePath;
      worktreeBranch =
        String(issueWorktreeBranchHint || "").trim() || `issue-hunter/${repo.id}/linked-${Date.now()}`;
    } else {
      const plan = this.worktreeManager.plan(repo.localPath, repo.id, Date.now());
      const addResult = await this.commandRunner(
        "git",
        ["-C", repo.localPath, "worktree", "add", "-b", plan.branch, plan.path, "HEAD"],
        { cwd: repo.localPath }
      );
      if (addResult.code !== 0) {
        throw new Error(
          `创建 worktree 失败: ${addResult.stderr || addResult.stdout || `git exit ${addResult.code}`}`
        );
      }
      worktreePath = plan.path;
      worktreeBranch = plan.branch;
    }

    const session: ChannelSession = {
      threadId,
      repoId: repo.id,
      channelId,
      issueKey: String(issueKeyHint || "").trim(),
      worktreePath,
      worktreeBranch,
      codexSessionId: String(codexSessionIdHint || "").trim(),
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(threadId, session);
    await this.persistSessions();
    // eslint-disable-next-line no-console
    console.info(
      `[issue-hunter][channel_codex] create thread=${threadId} issue=${session.issueKey || "-"} repo=${repo.owner}/${repo.repo} ` +
        `session=${session.codexSessionId || "-"} worktree=${session.worktreePath} branch=${session.worktreeBranch}`
    );
    return session;
  }

  private async ensureLoaded(): Promise<void> {
    if (this.sessionsLoaded) {
      return;
    }
    this.sessionsLoaded = true;
    try {
      const raw = await readFile(this.sessionFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<SessionSnapshot>;
      const list = Array.isArray(parsed.sessions) ? parsed.sessions : [];
      for (const item of list) {
        const threadId = String(item.threadId || "").trim();
        const repoId = String(item.repoId || "").trim();
        const worktreePath = String(item.worktreePath || "").trim();
        const worktreeBranch = String(item.worktreeBranch || "").trim();
        if (!threadId || !repoId || !worktreePath || !worktreeBranch) {
          continue;
        }
        this.sessions.set(threadId, {
          threadId,
          repoId,
          channelId: String(item.channelId || "").trim(),
          issueKey: String(item.issueKey || "").trim(),
          worktreePath,
          worktreeBranch,
          codexSessionId: String(item.codexSessionId || "").trim(),
          updatedAt: String(item.updatedAt || "").trim()
        });
      }
    } catch {
      // Ignore missing/invalid session file.
    }
  }

  private async persistSessions(): Promise<void> {
    const payload: SessionSnapshot = {
      sessions: [...this.sessions.values()].sort((a, b) => a.threadId.localeCompare(b.threadId)),
      updatedAt: new Date().toISOString()
    };
    await mkdir(dirname(resolve(this.sessionFilePath)), { recursive: true });
    await writeFile(this.sessionFilePath, JSON.stringify(payload, null, 2), "utf8");
  }
}

function createPostBatcher(
  post: (text: string) => Promise<void>,
  intervalMs: number
): {
  push: (text: string, options?: { immediate?: boolean }) => Promise<void>;
  stop: () => Promise<void>;
} {
  let pending: string[] = [];
  let sending = false;
  let stopped = false;
  let lastSentAt = 0;
  let lastSentText = "";
  const maxChars = Math.max(500, Number(process.env.ISSUE_HUNTER_SLACK_BATCH_MAX_CHARS || 2800));
  const separator = "\n\n──────────\n\n";

  const sendPending = async (force: boolean): Promise<void> => {
    if (sending || stopped || pending.length === 0) {
      return;
    }

    const now = Date.now();
    if (!force && lastSentAt > 0 && now - lastSentAt < intervalMs) {
      return;
    }

    const text = pending.join(separator);
    if (!force && text === lastSentText) {
      return;
    }

    pending = [];
    sending = true;
    try {
      await post(text);
      lastSentText = text;
      lastSentAt = Date.now();
    } catch {
      // Ignore transient Slack post failures to avoid interrupting codex run.
    } finally {
      sending = false;
    }
  };

  const timer = setInterval(() => {
    void sendPending(false);
  }, 1000);

  return {
    push: async (text: string, options?: { immediate?: boolean }) => {
      if (stopped) {
        return;
      }
      const normalized = String(text || "").trim();
      if (!normalized) {
        return;
      }

      const pendingLength = pending.join(separator).length;
      const additionalLength = normalized.length + (pending.length > 0 ? separator.length : 0);
      if (pending.length > 0 && pendingLength + additionalLength > maxChars) {
        await sendPending(true);
      }

      if (pending[pending.length - 1] !== normalized) {
        pending.push(normalized);
      }

      if (options?.immediate) {
        await sendPending(true);
      } else {
        await sendPending(false);
      }
    },
    stop: async () => {
      clearInterval(timer);
      await sendPending(true);
      stopped = true;
    }
  };
}

function findRepoBySlackChannel(config: AppConfig, channelId: string): RepositoryConfig | null {
  const normalized = String(channelId || "").trim();
  if (!normalized) {
    return null;
  }
  const matched = config.repositories.filter(
    (repo) =>
      repo.enabled && repo.slack.enabled && String(repo.slack.channelId || "").trim() === normalized
  );
  if (matched.length !== 1) {
    return null;
  }
  return matched[0];
}

function findRepoById(config: AppConfig, repoId: string): RepositoryConfig | null {
  const normalized = String(repoId || "").trim();
  if (!normalized) {
    return null;
  }
  return config.repositories.find((repo) => repo.id === normalized && repo.enabled) ?? null;
}

function buildCodexCommand(
  codexBin: string,
  backend: AgentBackend,
  worktreePath: string,
  sessionId: string,
  text: string
): { bin: string; args: string[] } {
  const args = [
    "exec",
    "--json",
    "--dangerously-bypass-approvals-and-sandbox",
    "--skip-git-repo-check",
    "--cd",
    worktreePath
  ];
  const resume = String(sessionId || "").trim();
  if (resume) {
    args.push("resume", resume);
  }
  args.push(String(text ?? ""));
  return {
    bin: resolveCodexBinary(codexBin, backend),
    args
  };
}

function extractLastNonEmptyLine(text: string): string {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return "";
  }
  return lines[lines.length - 1];
}

function formatSessionAckMessage(sessionId: string): string {
  const normalized = String(sessionId || "").trim();
  if (normalized) {
    return ` Codex Session: \`${normalized}\`（复用）。`;
  }
  return " Codex Session: 新会话创建中（启动后会回传 sessionId）。";
}

function truncate(text: string, maxLength: number): string {
  const value = String(text || "");
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

function formatLaunchFailure(error: unknown, commandBin: string, cwd?: string): string {
  const detail = error instanceof Error ? error.message : String(error);
  const code = String((error as { code?: unknown })?.code || "").trim();
  if (code === "ENOENT") {
    const normalizedCwd = String(cwd || "").trim();
    if (normalizedCwd && !existsSync(normalizedCwd)) {
      return `启动失败：工作目录不存在 "${normalizedCwd}"。该 thread 绑定的 worktree 可能已被清理，请重试后由系统自动重建。`;
    }
    if (!isCommandResolvable(commandBin)) {
      const pathPreview = truncate(String(process.env.PATH || ""), 180);
      return `未找到可执行命令 "${commandBin}"。请确认对应 CLI 已安装并在 PATH 中，或通过 ISSUE_HUNTER_CODEX_BIN / ISSUE_HUNTER_CLAUDE_BIN 指定绝对路径。PATH=${pathPreview || "(empty)"}`;
    }
    const pathPreview = truncate(String(process.env.PATH || ""), 180);
    return `启动命令失败（ENOENT）。command="${commandBin}", cwd="${normalizedCwd || "-"}", PATH=${pathPreview || "(empty)"}`;
  }
  return detail;
}

function isCommandResolvable(commandBin: string): boolean {
  const normalized = String(commandBin || "").trim();
  if (!normalized) {
    return false;
  }

  if (!normalized.includes("/") && !normalized.includes("\\")) {
    const entries = String(process.env.PATH || "")
      .split(delimiter)
      .map((item) => String(item || "").trim())
      .filter(Boolean);
    for (const entry of entries) {
      const candidate = join(entry, normalized);
      try {
        accessSync(candidate, fsConstants.X_OK);
        return true;
      } catch {
        // continue
      }
    }
    return false;
  }

  try {
    accessSync(normalized, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveCodexBinary(codexBin: string, backend: AgentBackend): string {
  const configured = String(codexBin || "").trim();
  if (configured && configured.toLowerCase() !== "auto") {
    return configured;
  }
  return resolveAgentBinary(backend);
}

export function resolveCodexBinaryForTest(codexBin: string, backend: AgentBackend = "codex"): string {
  return resolveCodexBinary(codexBin, backend);
}

function extractIssueNumberFromKey(issueKey: string): number {
  const match = String(issueKey || "").match(/#(\d+)\s*$/);
  if (!match) {
    return 0;
  }
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : 0;
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

async function isExistingDirectory(path: string): Promise<boolean> {
  const normalized = String(path || "").trim();
  if (!normalized) {
    return false;
  }
  try {
    const stats = await stat(normalized);
    return stats.isDirectory();
  } catch {
    return false;
  }
}
