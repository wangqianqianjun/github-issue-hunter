import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  SlackChannelCodexManager,
  resolveCodexBinaryForTest
} from "../src/core/slack-channel-codex-manager.js";
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
    prIssueReferenceMode: "close_keywords",
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
      planMode: false,
      agentBackend: "codex"
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
  it("resolves codex to an absolute executable from PATH", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-codex-path-"));
    const previousPath = process.env.PATH;
    try {
      const binDir = join(root, "bin");
      await mkdir(binDir, { recursive: true });
      const fakeCodex = join(binDir, "codex");
      await writeFile(fakeCodex, "#!/bin/sh\necho codex-cli 9.9.9\n", "utf8");
      await chmod(fakeCodex, 0o755);
      process.env.PATH = binDir;

      expect(resolveCodexBinaryForTest("")).toBe(fakeCodex);
    } finally {
      if (typeof previousPath === "string") {
        process.env.PATH = previousPath;
      } else {
        delete process.env.PATH;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

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
        runner as never,
        "true"
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
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not crash when codex binary is missing and posts actionable error", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-missing-codex-"));
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
        runner as never,
        "__missing_codex_binary__"
      );

      const posts: string[] = [];
      const result = await manager.handleMessage({
        threadId: "slack:C123:3.0",
        channelId: "C123",
        text: "please continue",
        isMention: false,
        post: async (text) => {
          posts.push(text);
        }
      });

      expect(result.accepted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(
        posts.some(
          (item) =>
            item.includes("未找到可执行命令") &&
            item.includes("__missing_codex_binary__")
        )
      ).toBe(true);
      expect(manager.getLoadSnapshot().runningTasks).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses ISSUE_HUNTER_CODEX_BIN when codex bin is not explicitly configured", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-env-codex-"));
    const previousIssueHunterBin = process.env.ISSUE_HUNTER_CODEX_BIN;
    const previousCodexBin = process.env.CODEX_BIN;
    process.env.ISSUE_HUNTER_CODEX_BIN = "__env_issue_hunter_codex__";
    delete process.env.CODEX_BIN;
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
        threadId: "slack:C123:4.0",
        channelId: "C123",
        text: "please continue",
        isMention: false,
        post: async (text) => {
          posts.push(text);
        }
      });

      expect(result.accepted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(posts.some((item) => item.includes("__env_issue_hunter_codex__"))).toBe(true);
    } finally {
      if (typeof previousIssueHunterBin === "string") {
        process.env.ISSUE_HUNTER_CODEX_BIN = previousIssueHunterBin;
      } else {
        delete process.env.ISSUE_HUNTER_CODEX_BIN;
      }
      if (typeof previousCodexBin === "string") {
        process.env.CODEX_BIN = previousCodexBin;
      } else {
        delete process.env.CODEX_BIN;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps explicit codex command when configured", () => {
    expect(resolveCodexBinaryForTest("codex")).toBe("codex");
  });

  it("uses issue-thread hints to reuse codex session without channel binding lookup", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-hint-"));
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

      const hintedIssueWorktree = join(root, "issue-worktree");
      await mkdir(hintedIssueWorktree, { recursive: true });
      let worktreeAddCount = 0;
      const runner = async (command: string, args: string[]) => {
        if (command === "git" && args.includes("worktree") && args.includes("add")) {
          worktreeAddCount += 1;
          const target = args[args.length - 2];
          await mkdir(target, { recursive: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      const sessionsFile = join(root, "runtime", "sessions.json");
      const manager = new SlackChannelCodexManager(
        configStore as never,
        sessionsFile,
        runner as never,
        "true"
      );

      const result = await manager.handleMessage({
        threadId: "slack:C123:22.0",
        channelId: "C123",
        text: "继续按上次上下文处理",
        isMention: false,
        repoIdHint: repo.id,
        codexSessionIdHint: "session-from-issue-record",
        issueKeyHint: "acme/web#201",
        issueWorktreePathHint: hintedIssueWorktree,
        issueWorktreeBranchHint: "issue-hunter/acme-web/201-fixed",
        post: async () => undefined
      });
      expect(result.accepted).toBe(true);
      expect(result.message).toContain("session-from-issue-record");
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(worktreeAddCount).toBe(0);

      const persisted = JSON.parse(await readFile(sessionsFile, "utf8")) as {
        sessions?: Array<{ threadId?: string; codexSessionId?: string; worktreePath?: string; issueKey?: string }>;
      };
      const target = (persisted.sessions || []).find((item) => item.threadId === "slack:C123:22.0");
      expect(target?.codexSessionId).toBe("session-from-issue-record");
      expect(target?.worktreePath).toBe(hintedIssueWorktree);
      expect(target?.issueKey).toBe("acme/web#201");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recreates missing persisted worktree before spawning codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-recover-worktree-"));
    try {
      const repoRoot = join(root, "repo");
      await mkdir(repoRoot, { recursive: true });
      const repo = makeRepo(repoRoot);
      const config = makeConfig(repo);
      const configStore = {
        load: async () => config
      };

      const sessionsFile = join(root, "runtime", "sessions.json");
      await mkdir(join(root, "runtime"), { recursive: true });
      const missingWorktree = join(root, "missing-worktree");
      await writeFile(
        sessionsFile,
        JSON.stringify(
          {
            sessions: [
              {
                threadId: "slack:C123:55.0",
                repoId: repo.id,
                channelId: "C123",
                issueKey: "acme/web#201",
                worktreePath: missingWorktree,
                worktreeBranch: "issue-hunter/acme-web/201-old",
                codexSessionId: "session-201",
                updatedAt: new Date().toISOString()
              }
            ],
            updatedAt: new Date().toISOString()
          },
          null,
          2
        ),
        "utf8"
      );

      let worktreeAddCount = 0;
      let recreatedWorktree = "";
      const runner = async (command: string, args: string[]) => {
        if (command === "git" && args.includes("worktree") && args.includes("add")) {
          worktreeAddCount += 1;
          const target = args[args.length - 2];
          recreatedWorktree = target;
          await mkdir(target, { recursive: true });
        }
        return { code: 0, stdout: "", stderr: "" };
      };

      const manager = new SlackChannelCodexManager(
        configStore as never,
        sessionsFile,
        runner as never,
        "true"
      );

      const posts: string[] = [];
      const result = await manager.handleMessage({
        threadId: "slack:C123:55.0",
        channelId: "C123",
        text: "继续修复",
        isMention: false,
        post: async (text) => {
          posts.push(text);
        }
      });
      expect(result.accepted).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(worktreeAddCount).toBe(1);
      expect(recreatedWorktree).not.toBe("");
      expect(recreatedWorktree).not.toBe(missingWorktree);
      expect(posts.some((item) => item.includes("未捕获可展示输出") || item.includes("处理失败"))).toBe(true);

      const persisted = JSON.parse(await readFile(sessionsFile, "utf8")) as {
        sessions?: Array<{ threadId?: string; worktreePath?: string; codexSessionId?: string }>;
      };
      const target = (persisted.sessions || []).find((item) => item.threadId === "slack:C123:55.0");
      expect(target?.worktreePath).toBe(recreatedWorktree);
      expect(target?.codexSessionId).toBe("session-201");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects switching issue binding inside one thread", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-channel-issue-bind-"));
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
        runner as never,
        "true"
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
      await rm(root, { recursive: true, force: true });
    }
  });
});
