import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import type { AppConfig, RepositoryConfig } from "../types/config.js";
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
  private sessionsLoaded = false;

  constructor(
    private readonly configStore: ConfigStore,
    private readonly sessionFilePath: string,
    private readonly commandRunner: CommandRunner = runCommand
  ) {}

  async handleMessage(input: ChannelMessageInput): Promise<ChannelMessageResult> {
    await this.ensureLoaded();
    const text = String(input.text || "").trim();
    if (!text) {
      return { accepted: false, message: "" };
    }

    const config = await this.configStore.load();
    const existing = this.sessions.get(input.threadId);
    const repo = existing
      ? findRepoById(config, existing.repoId)
      : input.repoIdHint
        ? findRepoById(config, input.repoIdHint)
        : findRepoBySlackChannel(config, input.channelId);

    if (!repo) {
      return { accepted: false, message: "" };
    }

    const wasBusy = this.runningByThread.has(input.threadId) || this.queues.has(input.threadId);
    const enqueuePromise = this.enqueue(input.threadId, async () => {
      await this.runCodexForMessage(repo, input);
    });
    void enqueuePromise;

    return {
      accepted: true,
      message: wasBusy
        ? `已收到，已加入当前 thread 队列（仓库: ${repo.owner}/${repo.repo}）。`
        : `已收到，开始在仓库 ${repo.owner}/${repo.repo} 处理中。`
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
        issueKey: "",
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

  private async enqueue(threadId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.queues.get(threadId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(task)
      .finally(() => {
        if (this.queues.get(threadId) === next) {
          this.queues.delete(threadId);
        }
      });
    this.queues.set(threadId, next);
    await next;
  }

  private async runCodexForMessage(repo: RepositoryConfig, input: ChannelMessageInput): Promise<void> {
    const session = await this.getOrCreateSession(
      repo,
      input.threadId,
      input.channelId,
      String(input.codexSessionIdHint || "").trim()
    );
    const command = buildCodexCommand(session.worktreePath, session.codexSessionId, input.text);

    const child = spawn(command.bin, command.args, {
      cwd: session.worktreePath,
      stdio: ["ignore", "pipe", "pipe"]
    });
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
          await input.post(`Assistant: 🧠 ${truncate(reasoning, 300)}`);
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

    child.stdout.on("data", (chunk) => {
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

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    const code = await new Promise<number>((resolve) => {
      child.on("close", (exitCode) => {
        resolve(exitCode ?? 1);
      });
    });

    this.runningByThread.delete(input.threadId);

    if (lineBuffer.trim()) {
      await consumeLine(lineBuffer);
    }

    if (sessionId && sessionId !== session.codexSessionId) {
      session.codexSessionId = sessionId;
      session.updatedAt = new Date().toISOString();
      this.sessions.set(input.threadId, session);
      await this.persistSessions();
    }

    if (code !== 0) {
      const detail = truncate(stderr || stdout || `exit=${code}`, 1200);
      await input.post(`处理失败: ${detail}`);
      return;
    }

    const finalText = lastAssistantMessage || extractLastNonEmptyLine(stdout) || "已完成，但未捕获可展示输出。";
    await input.post(finalText);
  }

  private async getOrCreateSession(
    repo: RepositoryConfig,
    threadId: string,
    channelId: string,
    codexSessionIdHint: string
  ): Promise<ChannelSession> {
    const existing = this.sessions.get(threadId);
    if (existing && existing.repoId === repo.id) {
      const hint = String(codexSessionIdHint || "").trim();
      if (hint && !existing.codexSessionId) {
        existing.codexSessionId = hint;
        existing.updatedAt = new Date().toISOString();
        this.sessions.set(threadId, existing);
        await this.persistSessions();
      }
      return existing;
    }

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

    const session: ChannelSession = {
      threadId,
      repoId: repo.id,
      channelId,
      worktreePath: plan.path,
      worktreeBranch: plan.branch,
      codexSessionId: String(codexSessionIdHint || "").trim(),
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(threadId, session);
    await this.persistSessions();
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

function buildCodexCommand(worktreePath: string, sessionId: string, text: string): { bin: string; args: string[] } {
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
  args.push(text);
  return {
    bin: process.env.ISSUE_HUNTER_CODEX_BIN || "codex",
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

function truncate(text: string, maxLength: number): string {
  const value = String(text || "");
  if (value.length <= maxLength) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxLength - 3))}...`;
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
