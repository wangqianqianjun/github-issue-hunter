import { describe, expect, it } from "vitest";

import type { AppConfig, IssueExecutionRecord, RepositoryConfig } from "../src/types/config.js";
import type { IssueNotifier } from "../src/core/issue-engine.js";
import { IssueEngine } from "../src/core/issue-engine.js";
import {
  DEFAULT_IGNORE_WORDING,
  DEFAULT_IMPLEMENT_WORDING,
  DEFAULT_TRIAGE_WORDING
} from "../src/core/defaults.js";

class FakeGitHubClient {
  comments: string[] = [];
  closed: number[] = [];
  issueComments: Record<string, unknown>[];
  openIssuesOverride: Record<string, unknown>[] | null = null;

  constructor(
    private readonly issue: Record<string, unknown>,
    initialComments: Record<string, unknown>[] = []
  ) {
    this.issueComments = [...initialComments];
  }

  async listOpenIssues(): Promise<Record<string, unknown>[]> {
    if (this.openIssuesOverride) {
      return this.openIssuesOverride;
    }
    return [this.issue];
  }

  async getIssue(issueNumber: number): Promise<Record<string, unknown>> {
    if (issueNumber !== this.issue.number) {
      throw new Error("issue mismatch");
    }
    return this.issue;
  }

  async listIssueComments(): Promise<Record<string, unknown>[]> {
    return this.issueComments;
  }

  async createIssueComment(_issueNumber: number, body: string): Promise<void> {
    this.comments.push(body);
    this.issueComments.push({ body });
  }

  async closeIssue(issueNumber: number): Promise<void> {
    this.closed.push(issueNumber);
  }

  async downloadImages(): Promise<string[]> {
    return [];
  }
}

class FakeCodexRunner {
  triageRuns = 0;
  implementRuns = 0;
  lastImplementUserMessage = "";
  lastTriageResumeSessionId = "";
  lastImplementResumeSessionId = "";

  constructor(
    private readonly triageResult: Record<string, unknown>,
    private readonly implementResult: Record<string, unknown>,
    private readonly triageUpdates: string[] = [],
    private readonly implementUpdates: string[] = []
  ) {}

  async runTriage(
    _contextFile: string,
    _issueNumber: number,
    _issueTitle: string,
    _workingDirectory?: string,
    onProgress?: (update: string) => Promise<void> | void,
    _abortSignal?: AbortSignal,
    resumeSessionId?: string
  ): Promise<Record<string, unknown>> {
    this.triageRuns += 1;
    this.lastTriageResumeSessionId = String(resumeSessionId || "");
    for (const update of this.triageUpdates) {
      await onProgress?.(update);
    }
    return this.triageResult;
  }

  async runImplementation(
    _contextFile: string,
    _issueNumber: number,
    _issueTitle: string,
    originalUserMessage: string,
    _workingDirectory?: string,
    onProgress?: (update: string) => Promise<void> | void,
    _abortSignal?: AbortSignal,
    resumeSessionId?: string
  ): Promise<Record<string, unknown>> {
    this.implementRuns += 1;
    this.lastImplementUserMessage = originalUserMessage;
    this.lastImplementResumeSessionId = String(resumeSessionId || "");
    for (const update of this.implementUpdates) {
      await onProgress?.(update);
    }
    return this.implementResult;
  }
}

class FakeNotifier implements IssueNotifier {
  issueStarts: Record<string, unknown>[] = [];
  updates: Array<{ threadTs: string; text: string }> = [];
  readonly threadTs = "thread-123";

  async postIssueStart(issue: Record<string, unknown>): Promise<string> {
    this.issueStarts.push(issue);
    return this.threadTs;
  }

  async postThreadUpdate(threadTs: string, text: string): Promise<void> {
    this.updates.push({ threadTs, text });
  }
}

class FakeRuntimeStore {
  seen = new Set<string>();
  records: IssueExecutionRecord[] = [];

  async isSeen(issueKey: string): Promise<boolean> {
    return this.seen.has(issueKey);
  }

  async getRecord(issueKey: string): Promise<IssueExecutionRecord | null> {
    return this.records.find((item) => item.issueKey === issueKey) ?? null;
  }

  async markSeen(issueKey: string): Promise<void> {
    this.seen.add(issueKey);
  }

  async saveRecord(record: IssueExecutionRecord): Promise<void> {
    const idx = this.records.findIndex((item) => item.issueKey === record.issueKey);
    if (idx >= 0) {
      this.records[idx] = record;
      return;
    }
    this.records.push(record);
  }

  async listCompleted(): Promise<IssueExecutionRecord[]> {
    return this.records.filter((item) => item.state === "completed");
  }

  async listAll(): Promise<IssueExecutionRecord[]> {
    return [...this.records];
  }
}

type CommandResult = {
  code: number;
  stdout: string;
  stderr: string;
};

type CommandCall = {
  command: string;
  args: string[];
  cwd?: string;
};

function extractPrCreateBody(calls: CommandCall[]): string {
  const call = calls.find((item) => item.command === "gh" && item.args[0] === "pr" && item.args[1] === "create");
  if (!call) {
    return "";
  }
  const bodyIndex = call.args.indexOf("--body");
  if (bodyIndex < 0) {
    return "";
  }
  return String(call.args[bodyIndex + 1] || "");
}

const makeRepo = (id: string, owner: string, repo: string): RepositoryConfig => ({
  id,
  owner,
  repo,
  localPath: `/tmp/${owner}-${repo}`,
  triageCommand: "triage {context_file}",
  implementCommand: "implement {context_file}",
  triageWording: DEFAULT_TRIAGE_WORDING,
  implementWording: DEFAULT_IMPLEMENT_WORDING,
  ignoreWording: DEFAULT_IGNORE_WORDING,
  prIssueReferenceMode: "close_keywords",
  enabled: true,
  perRepoConcurrency: 1,
  slack: {
    enabled: false,
    channelId: "",
    transport: "none"
  }
});

const makeConfig = (repositories: RepositoryConfig[]): AppConfig => ({
  repositories,
  global: {
    pollIntervalSeconds: 30,
    globalConcurrency: 2,
    workspaceDir: ".",
    closeIssueOnDone: true,
    keepWorktrees: false,
    planMode: false,
    agentBackend: "codex"
  },
  slackApp: {
    enabled: false,
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
    useSocketMode: false
  },
  serviceState: {
    running: false,
    lastRunAt: "",
    lastError: "",
    activeTasks: 0
  }
});

describe("IssueEngine", () => {
  it("handles ignored and completed flows across multiple repositories", async () => {
    const repoA = makeRepo("repo-a", "acme", "web");
    const repoB = makeRepo("repo-b", "acme", "api");
    const config = makeConfig([repoA, repoB]);

    const ghA = new FakeGitHubClient({
      number: 11,
      title: "docs question",
      body: "question",
      html_url: "https://github.com/acme/web/issues/11"
    });
    const ghB = new FakeGitHubClient({
      number: 12,
      title: "panic in parser",
      body: "bug",
      html_url: "https://github.com/acme/api/issues/12"
    });

    const runtime = new FakeRuntimeStore();

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: (repo) => (repo.id === "repo-a" ? ghA : ghB),
      codexFactory: (repo) => {
        if (repo.id === "repo-a") {
          return new FakeCodexRunner({ needs_processing: false, reason: "not planned" }, {});
        }
        return new FakeCodexRunner(
          { needs_processing: true, reason: "valid bug" },
          {
            summary: "parser nil pointer",
            root_cause: "missing nil check",
            solution: "add guard and tests",
            pr_url: "https://github.com/acme/api/pull/88",
            test_cases: [{ name: "parser nil", path: "tests/parser.test.ts" }]
          }
        );
      },
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(ghA.comments.some((item) => item.includes(DEFAULT_TRIAGE_WORDING))).toBe(true);
    expect(ghA.comments.some((item) => item.includes(DEFAULT_IGNORE_WORDING))).toBe(true);
    expect(ghA.comments.some((item) => item.includes("原因:\nnot planned"))).toBe(true);
    expect(ghB.comments.some((item) => item.includes(DEFAULT_IMPLEMENT_WORDING))).toBe(true);
    expect(ghB.comments.some((item) => item.includes("Reason:\nvalid bug"))).toBe(true);
    expect(ghB.comments.some((line) => line.includes("RootCause"))).toBe(true);
    expect(ghB.closed).toEqual([12]);

    const completed = await runtime.listCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0].prUrl).toContain("/pull/88");
  });

  it("posts triage progress, triage result, and decision to the same slack thread", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 21,
      title: "bug",
      body: "body",
      html_url: "https://github.com/acme/web/issues/21"
    });

    const runtime = new FakeRuntimeStore();
    const notifier = new FakeNotifier();
    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "valid bug" },
      {
        summary: "fixed",
        root_cause: "missing guard",
        solution: "add guard",
        pr_url: "https://github.com/acme/web/pull/21",
        test_cases: []
      },
      ["推理进展: triage check"],
      ["Tool: npm test (completed)"]
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => notifier,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(codex.triageRuns).toBe(1);
    expect(notifier.issueStarts).toHaveLength(1);
    expect(notifier.updates.every((item) => item.threadTs === notifier.threadTs)).toBe(true);
    expect(notifier.updates.some((item) => item.text.includes("Issue 已进入评估阶段，AI 将判断下一阶段。"))).toBe(true);
    expect(notifier.updates.some((item) => item.text.includes("推理进展: triage check"))).toBe(true);
    expect(notifier.updates.some((item) => item.text.includes("Triage 理由:"))).toBe(true);
    expect(notifier.updates.some((item) => item.text.includes("valid bug"))).toBe(true);
    expect(notifier.updates.some((item) => item.text.includes("决定：进入开发处理。"))).toBe(true);
    expect(notifier.updates.some((item) => item.text.includes("Tool: npm test (completed)"))).toBe(true);
    expect(notifier.updates.some((item) => item.text.includes("处理完成。PR: https://github.com/acme/web/pull/21"))).toBe(true);
  });

  it("skips duplicate issue when already completed and no new signals", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);

    const gh = new FakeGitHubClient({
      number: 13,
      title: "duplicate",
      body: "duplicate",
      html_url: "https://github.com/acme/web/issues/13"
    });

    const runtime = new FakeRuntimeStore();
    await runtime.markSeen("acme/web#13");
    await runtime.saveRecord({
      issueKey: "acme/web#13",
      repoId: repo.id,
      issueNumber: 13,
      state: "implementing",
      summary: "done",
      prUrl: "https://github.com/acme/web/pull/13",
      rootCause: "na",
      solution: "na",
      closedAt: new Date().toISOString(),
      threadTs: "",
      lastExternalCommentId: 0,
      updatedAt: new Date().toISOString()
    });

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => new FakeCodexRunner({ needs_processing: true }, {}),
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(gh.comments).toEqual([]);
  });

  it("retries seen failed issue by forwarding directly to implementation", async () => {
    const previousAutoRetry = process.env.FAILED_ISSUE_AUTO_RETRY;
    process.env.FAILED_ISSUE_AUTO_RETRY = "1";
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 14,
      title: "retry me",
      body: "retry me",
      html_url: "https://github.com/acme/web/issues/14"
    });
    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#14";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 14,
      state: "failed",
      summary: "previous failed run",
      prUrl: "",
      rootCause: "",
      solution: "",
      closedAt: "",
      threadTs: "",
      updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString()
    });

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () =>
        new FakeCodexRunner(
          { needs_processing: false, reason: "not planned" },
          {
            summary: "retry fix applied",
            root_cause: "transient failure",
            solution: "rerun with latest context",
            pr_url: "https://github.com/acme/web/pull/14",
            test_cases: []
          }
        ),
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    try {
      await engine.runOnce();
    } finally {
      if (previousAutoRetry === undefined) {
        delete process.env.FAILED_ISSUE_AUTO_RETRY;
      } else {
        process.env.FAILED_ISSUE_AUTO_RETRY = previousAutoRetry;
      }
    }

    expect(gh.comments.some((item) => item.includes(DEFAULT_TRIAGE_WORDING))).toBe(false);
    expect(gh.comments.some((item) => item.includes("PR:\nhttps://github.com/acme/web/pull/14"))).toBe(true);
  });

  it("recovers stale in-flight issue by forwarding directly to implementation", async () => {
    const previousStaleSeconds = process.env.ISSUE_HUNTER_STALE_IN_FLIGHT_RETRY_SECONDS;
    process.env.ISSUE_HUNTER_STALE_IN_FLIGHT_RETRY_SECONDS = "60";

    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 185,
      title: "stale triaging",
      body: "stale triaging",
      html_url: "https://github.com/acme/web/issues/185"
    });
    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#185";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 185,
      state: "triaging",
      summary: "",
      prUrl: "",
      rootCause: "",
      solution: "",
      closedAt: "",
      threadTs: "",
      updatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: false, reason: "already fixed" },
      {
        summary: "stale task recovered",
        root_cause: "worker stalled",
        solution: "resume and complete",
        pr_url: "https://github.com/acme/web/pull/185",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    try {
      await engine.runOnce();
    } finally {
      if (previousStaleSeconds === undefined) {
        delete process.env.ISSUE_HUNTER_STALE_IN_FLIGHT_RETRY_SECONDS;
      } else {
        process.env.ISSUE_HUNTER_STALE_IN_FLIGHT_RETRY_SECONDS = previousStaleSeconds;
      }
    }

    const record = await runtime.getRecord(issueKey);
    expect(codex.triageRuns).toBe(0);
    expect(codex.implementRuns).toBe(1);
    expect(record?.state).toBe("completed");
    expect(record?.lastTriggerType).toBe("stale_recovery");
  });

  it("forwards completed issue new github comment directly to implementation", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient(
      {
        number: 66,
        title: "regression report",
        body: "regression report",
        html_url: "https://github.com/acme/web/issues/66"
      },
      [{ id: 1001, body: "still broken", created_at: "2026-02-26T00:00:00.000Z" }]
    );

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#66";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 66,
      state: "completed",
      summary: "fixed",
      prUrl: "https://github.com/acme/web/pull/66",
      rootCause: "na",
      solution: "na",
      closedAt: "2026-02-25T00:00:00.000Z",
      threadTs: "",
      lastExternalCommentId: 1000,
      updatedAt: new Date().toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: false, reason: "already fixed after re-check" },
      {
        summary: "follow-up handled",
        root_cause: "additional edge case",
        solution: "applied follow-up patch",
        pr_url: "https://github.com/acme/web/pull/660",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();
    expect(codex.triageRuns).toBe(0);
    expect(codex.implementRuns).toBe(1);
  });

  it("includes reused codex session id in first thread update on follow-up comments", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient(
      {
        number: 167,
        title: "follow-up with reused session",
        body: "issue body",
        html_url: "https://github.com/acme/web/issues/167"
      },
      [{ id: 7002, body: "继续修复这个问题", created_at: "2026-03-04T00:00:00.000Z" }]
    );

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#167";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 167,
      state: "completed",
      summary: "previous run",
      prUrl: "https://github.com/acme/web/pull/167",
      rootCause: "na",
      solution: "na",
      closedAt: "2026-03-03T00:00:00.000Z",
      threadTs: "",
      lastExternalCommentId: 7001,
      codexSessionId: "sess-reuse-167",
      updatedAt: new Date().toISOString()
    });

    const notifier = new FakeNotifier();
    const codex = new FakeCodexRunner(
      { needs_processing: false, reason: "already addressed" },
      {
        summary: "done",
        root_cause: "na",
        solution: "na",
        pr_url: "https://github.com/acme/web/pull/167",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => notifier,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(notifier.updates.some((item) => item.text.includes("Codex Session: `sess-reuse-167`（复用）"))).toBe(true);
  });

  it("forwards failed issue new github comment directly to implementation", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient(
      {
        number: 68,
        title: "failed before, new input",
        body: "please retry",
        html_url: "https://github.com/acme/web/issues/68"
      },
      [{ id: 3002, body: "new finding after failure", created_at: "2026-02-27T00:00:00.000Z" }]
    );

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#68";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 68,
      state: "failed",
      summary: "previous parse error",
      prUrl: "",
      rootCause: "",
      solution: "",
      closedAt: "",
      threadTs: "",
      lastExternalCommentId: 3001,
      updatedAt: new Date().toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: false, reason: "validated with new input" },
      {
        summary: "fixed after follow-up",
        root_cause: "missing guard on retry path",
        solution: "add guard and verify",
        pr_url: "https://github.com/acme/web/pull/680",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();
    expect(codex.triageRuns).toBe(0);
    expect(codex.implementRuns).toBe(1);
  });

  it("passes latest external user comment directly to implement stage", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient(
      {
        number: 67,
        title: "regression report",
        body: "original body",
        html_url: "https://github.com/acme/web/issues/67"
      },
      [{ id: 2001, body: "still broken after patch", created_at: "2026-02-26T00:00:00.000Z" }]
    );

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#67";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 67,
      state: "completed",
      summary: "fixed",
      prUrl: "https://github.com/acme/web/pull/67",
      rootCause: "na",
      solution: "na",
      closedAt: "2026-02-25T00:00:00.000Z",
      threadTs: "",
      lastExternalCommentId: 2000,
      updatedAt: new Date().toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "needs another fix" },
      {
        summary: "fixed again",
        root_cause: "edge case",
        solution: "patch and tests",
        pr_url: "https://github.com/acme/web/pull/670",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();
    expect(codex.triageRuns).toBe(0);
    expect(codex.implementRuns).toBe(1);
    expect(codex.lastImplementUserMessage).toBe("still broken after patch");
  });

  it("keeps slack-signal implement input isolated from github issue comments", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient(
      {
        number: 77,
        title: "slack follow-up",
        body: "original issue body",
        html_url: "https://github.com/acme/web/issues/77"
      },
      [{ id: 5001, body: "github comment should not be forwarded in slack trigger", created_at: "2026-03-03T00:00:00.000Z" }]
    );

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#77";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 77,
      state: "completed",
      summary: "done once",
      prUrl: "https://github.com/acme/web/pull/77",
      rootCause: "na",
      solution: "na",
      closedAt: "2026-03-02T00:00:00.000Z",
      threadTs: "slack:C123:1770000000.000001",
      lastExternalCommentId: 5001,
      lastExternalCommentAt: "2026-03-03T00:00:00.000Z",
      lastSlackSignalAt: "2026-03-03T00:05:00.000Z",
      lastHandledSlackSignalAt: "",
      lastSlackSignalText: "",
      updatedAt: new Date().toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "needs processing from slack instruction" },
      {
        summary: "done",
        root_cause: "cause",
        solution: "solution",
        pr_url: "https://github.com/acme/web/pull/770",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(codex.triageRuns).toBe(0);
    expect(codex.implementRuns).toBe(1);
    expect(codex.lastImplementUserMessage).toContain("User sent a Slack instruction");
    expect(codex.lastImplementUserMessage).not.toContain("github comment should not be forwarded");
  });

  it("enters awaiting approval state in plan mode before implementation", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    config.global.planMode = true;
    const gh = new FakeGitHubClient({
      number: 170,
      title: "needs design first",
      body: "please fix with plan",
      html_url: "https://github.com/acme/web/issues/170"
    });

    const runtime = new FakeRuntimeStore();
    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "valid bug" },
      {
        summary: "split loading and rendering paths",
        root_cause: "missing separation in current flow",
        solution: "1) refactor service 2) add tests 3) verify rollback path",
        pr_url: "",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(codex.triageRuns).toBe(1);
    expect(codex.implementRuns).toBe(1);
    expect(gh.comments.some((item) => item.includes(DEFAULT_TRIAGE_WORDING))).toBe(true);
    expect(gh.comments.some((item) => item.includes("等待审批"))).toBe(true);
    expect(gh.comments.some((item) => item.includes(DEFAULT_IMPLEMENT_WORDING))).toBe(true);
    expect(gh.comments.some((item) => item.includes("Reason:\nvalid bug"))).toBe(false);
    expect(gh.closed).toEqual([]);

    const record = await runtime.getRecord("acme/web#170");
    expect(record?.state).toBe("awaiting_approval");
    expect(record?.summary).toBe("valid bug");
    expect(record?.solution).toContain("Summary:");
    expect(codex.lastImplementUserMessage).toBe("please fix with plan");
  });

  it("forwards approval comment in awaiting_approval directly to implementation", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    config.global.planMode = true;
    const gh = new FakeGitHubClient(
      {
        number: 171,
        title: "approved issue",
        body: "approved issue body",
        html_url: "https://github.com/acme/web/issues/171"
      },
      [{ id: 901, body: "approve，按方案开始实现", created_at: "2026-02-28T00:00:00.000Z" }]
    );

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#171";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 171,
      state: "awaiting_approval",
      summary: "triage reason from previous run",
      prUrl: "",
      rootCause: "old root cause",
      solution: "Summary:\nold plan\n\nSolution:\nimplement in three steps",
      closedAt: "",
      threadTs: "",
      lastExternalCommentId: 900,
      updatedAt: new Date().toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "approved and ready to implement", next_step: "implement" },
      {
        summary: "done",
        root_cause: "cause",
        solution: "solution",
        pr_url: "https://github.com/acme/web/pull/171",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(codex.triageRuns).toBe(0);
    expect(codex.implementRuns).toBe(1);
    expect(codex.lastImplementUserMessage).toBe("approve，按方案开始实现");
    expect(gh.comments.some((item) => item.includes(DEFAULT_IMPLEMENT_WORDING))).toBe(false);
    expect(gh.comments.some((item) => item.includes("PR:\nhttps://github.com/acme/web/pull/171"))).toBe(true);
  });

  it("forwards awaiting_approval follow-up comment directly to implementation", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    config.global.planMode = true;
    const gh = new FakeGitHubClient(
      {
        number: 172,
        title: "needs updated plan",
        body: "issue body",
        html_url: "https://github.com/acme/web/issues/172"
      },
      [{ id: 1001, body: "我并不满意，方案请继续调整", created_at: "2026-03-01T00:00:00.000Z" }]
    );

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#172";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 172,
      state: "awaiting_approval",
      summary: "old plan summary",
      prUrl: "",
      rootCause: "old root cause",
      solution: "old plan body",
      closedAt: "",
      threadTs: "",
      lastExternalCommentId: 1000,
      updatedAt: new Date().toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "needs revised plan", next_step: "plan" },
      {
        summary: "implemented revised solution",
        root_cause: "scope not aligned",
        solution: "applied adjusted implementation",
        pr_url: "https://github.com/acme/web/pull/172",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(codex.triageRuns).toBe(0);
    expect(codex.implementRuns).toBe(1);
    const record = await runtime.getRecord(issueKey);
    expect(record?.state).toBe("completed");
    expect(record?.summary).toContain("implemented revised solution");
    expect(codex.lastImplementUserMessage).toBe("我并不满意，方案请继续调整");
  });

  it("uses one shared codex session per issue and stores latest session id", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient(
      {
        number: 69,
        title: "clarification loop",
        body: "need more details",
        html_url: "https://github.com/acme/web/issues/69"
      },
      [{ id: 4002, body: "补充了新的需求边界", created_at: "2026-02-27T00:00:00.000Z" }]
    );

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#69";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 69,
      state: "completed",
      summary: "older result",
      prUrl: "https://github.com/acme/web/pull/1",
      rootCause: "na",
      solution: "na",
      closedAt: "2026-02-26T00:00:00.000Z",
      threadTs: "slack:C123:1.23",
      lastExternalCommentId: 4001,
      triageSessionId: "triage-old",
      implementSessionId: "implement-old",
      updatedAt: new Date().toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "needs implementation", codex_session_id: "triage-new" },
      {
        summary: "done",
        root_cause: "cause",
        solution: "solution",
        pr_url: "https://github.com/acme/web/pull/69",
        codex_session_id: "implement-new",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(codex.triageRuns).toBe(0);
    expect(codex.lastTriageResumeSessionId).toBe("");
    expect(codex.lastImplementResumeSessionId).toBe("implement-old");

    const record = await runtime.getRecord(issueKey);
    expect(record?.codexSessionId).toBe("implement-new");
    expect(record?.triageSessionId).toBe("implement-new");
    expect(record?.implementSessionId).toBe("implement-new");
  });

  it("reuses the same issue worktree metadata on new comments", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 88,
      title: "follow-up on same issue",
      body: "please fix",
      html_url: "https://github.com/acme/web/issues/88"
    });

    const runtime = new FakeRuntimeStore();
    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "valid bug" },
      {
        summary: "fixed",
        root_cause: "missing guard",
        solution: "add guard",
        pr_url: "https://github.com/acme/web/pull/88",
        test_cases: []
      }
    );
    const observedExistingRecords: Array<IssueExecutionRecord | null | undefined> = [];

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async (_repo, _issue, _comments, _imageUrls, existingRecord) => {
        observedExistingRecords.push(existingRecord);
        return {
          contextFile: "/tmp/context.json",
          worktreePath: "/tmp/worktrees/issue-88",
          worktreeBranch: "issue-hunter/acme-web/88",
          worktreeCreated: true,
          cleanup: async () => undefined
        };
      }
    });

    await engine.runOnce();
    gh.issueComments.push({ id: 9001, body: "new follow-up request", created_at: "2026-03-02T00:00:00.000Z" });
    await engine.runOnce();

    expect(observedExistingRecords[0]).toBeNull();
    expect(observedExistingRecords[1]?.issueWorktreePath).toBe("/tmp/worktrees/issue-88");
    expect(observedExistingRecords[1]?.issueWorktreeBranch).toBe("issue-hunter/acme-web/88");

    const record = await runtime.getRecord("acme/web#88");
    expect(record?.issueWorktreePath).toBe("/tmp/worktrees/issue-88");
    expect(record?.issueWorktreeBranch).toBe("issue-hunter/acme-web/88");
    expect(codex.implementRuns).toBe(2);
  });

  it("cleans issue worktree automatically after issue is closed", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 193,
      title: "closed issue cleanup",
      body: "already done",
      state: "closed",
      html_url: "https://github.com/acme/web/issues/193"
    });
    gh.openIssuesOverride = [];

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#193";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 193,
      state: "completed",
      summary: "done",
      prUrl: "https://github.com/acme/web/pull/193",
      rootCause: "",
      solution: "",
      closedAt: "",
      threadTs: "",
      issueWorktreePath: "/tmp/worktrees/issue-193",
      issueWorktreeBranch: "issue-hunter/acme-web/193",
      updatedAt: new Date().toISOString()
    });

    const calls: CommandCall[] = [];
    const commandRunner = async (
      command: string,
      args: string[],
      options?: { cwd?: string; input?: string }
    ): Promise<CommandResult> => {
      calls.push({ command, args, cwd: options?.cwd });
      return { code: 0, stdout: "", stderr: "" };
    };

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => new FakeCodexRunner({ needs_processing: false, reason: "skip" }, {}),
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      commandRunner
    });

    await engine.runOnce();

    expect(
      calls.some(
        (call) =>
          call.command === "git" &&
          call.args.join(" ").includes("worktree remove --force /tmp/worktrees/issue-193")
      )
    ).toBe(true);
    expect(
      calls.some(
        (call) =>
          call.command === "git" &&
          call.args.join(" ").includes("branch -D issue-hunter/acme-web/193")
      )
    ).toBe(true);

    const record = await runtime.getRecord(issueKey);
    expect(record?.issueWorktreePath).toBe("");
    expect(record?.issueWorktreeBranch).toBe("");
  });

  it("forwards pending slack signal directly to implementation", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 77,
      title: "slack follow-up",
      body: "slack follow-up",
      html_url: "https://github.com/acme/web/issues/77"
    });

    const runtime = new FakeRuntimeStore();
    const issueKey = "acme/web#77";
    await runtime.markSeen(issueKey);
    await runtime.saveRecord({
      issueKey,
      repoId: repo.id,
      issueNumber: 77,
      state: "completed",
      summary: "fixed",
      prUrl: "https://github.com/acme/web/pull/77",
      rootCause: "na",
      solution: "na",
      closedAt: "2026-02-25T00:00:00.000Z",
      threadTs: "slack:C123:174",
      lastExternalCommentId: 0,
      lastSlackSignalAt: "2026-02-26T00:00:00.000Z",
      lastHandledSlackSignalAt: "2026-02-25T00:00:00.000Z",
      lastSlackSignalText: "Please check again",
      updatedAt: new Date().toISOString()
    });

    const codex = new FakeCodexRunner(
      { needs_processing: false, reason: "verified from latest instruction" },
      {
        summary: "checked again",
        root_cause: "na",
        solution: "handled slack follow-up",
        pr_url: "https://github.com/acme/web/pull/771",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();
    expect(codex.triageRuns).toBe(0);
    expect(codex.implementRuns).toBe(1);
    const updated = await runtime.getRecord(issueKey);
    expect(updated?.lastHandledSlackSignalAt).toBe("2026-02-26T00:00:00.000Z");
  });

  it("stops running codex by slack thread token", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 15,
      title: "long running task",
      body: "long running task",
      html_url: "https://github.com/acme/web/issues/15"
    });
    const runtime = new FakeRuntimeStore();
    const notifier = new FakeNotifier();

    class BlockingCodexRunner extends FakeCodexRunner {
      override async runImplementation(
        _contextFile: string,
        _issueNumber: number,
        _issueTitle: string,
        _originalUserMessage: string,
        _workingDirectory?: string,
        onProgress?: (update: string) => Promise<void> | void,
        abortSignal?: AbortSignal,
        _resumeSessionId?: string
      ): Promise<Record<string, unknown>> {
        await onProgress?.("starting long implementation");
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Error("Codex command cancelled by stop request"));
          if (abortSignal?.aborted) {
            onAbort();
            return;
          }
          abortSignal?.addEventListener("abort", onAbort, { once: true });
        });
        return {};
      }
    }

    const codex = new BlockingCodexRunner(
      { needs_processing: true, reason: "valid bug" },
      {}
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => notifier,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    const runPromise = engine.runOnce();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const stopResult = engine.stopByThread(notifier.threadTs);
    expect(stopResult.stopped).toBe(true);
    expect(stopResult.issueKey).toBe("acme/web#15");

    await runPromise;
    const record = await runtime.getRecord("acme/web#15");
    expect(record?.state).toBe("failed");
    expect(record?.summary).toContain("Cancelled");
    expect(notifier.updates.some((item) => item.text.includes("已收到停止指令"))).toBe(true);
  });

  it("skips posting duplicate triage/implement/completion comments", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const completionBody = [
      "Reason:",
      "valid bug",
      "",
      "Summary:",
      "fixed",
      "",
      "RootCause:",
      "missing guard",
      "",
      "Solution:",
      "add guard",
      "",
      "PR:",
      "https://github.com/acme/web/pull/99"
    ].join("\n");

    const gh = new FakeGitHubClient(
      {
        number: 99,
        title: "duplicate comments",
        body: "duplicate comments",
        html_url: "https://github.com/acme/web/issues/99"
      },
      [{ body: DEFAULT_TRIAGE_WORDING }, { body: DEFAULT_IMPLEMENT_WORDING }, { body: completionBody }]
    );

    const runtime = new FakeRuntimeStore();
    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "valid bug" },
      {
        summary: "fixed",
        root_cause: "missing guard",
        solution: "add guard",
        pr_url: "https://github.com/acme/web/pull/99",
        test_cases: []
      }
    );

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
    });

    await engine.runOnce();

    expect(gh.comments).toEqual([]);
  });

  it("auto creates PR when implement result has no pr_url", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 120,
      title: "missing pr url",
      body: "fix this",
      html_url: "https://github.com/acme/web/issues/120"
    });
    const runtime = new FakeRuntimeStore();

    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "valid bug" },
      {
        summary: "fixed",
        root_cause: "missing guard",
        solution: "add guard and test",
        test_cases: []
      }
    );

    const calls: CommandCall[] = [];
    const commandRunner = async (
      command: string,
      args: string[],
      options?: { cwd?: string; input?: string }
    ): Promise<CommandResult> => {
      calls.push({ command, args, cwd: options?.cwd });

      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: " M src/main.ts\n", stderr: "" };
      }
      if (command === "git" && args[0] === "add") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "commit") {
        return { code: 0, stdout: "[issue-hunter/120 1234abc] test", stderr: "" };
      }
      if (command === "git" && args[0] === "push") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (command === "git" && args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { code: 0, stdout: "1\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        return { code: 0, stdout: "https://github.com/acme/web/pull/120\n", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    };

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      commandRunner,
      prepareWorkspace: async () => ({
        contextFile: "/tmp/context.json",
        worktreePath: "/tmp/worktree",
        worktreeBranch: "issue-hunter/acme-web/120-abcd",
        worktreeCreated: true,
        cleanup: async () => undefined
      })
    });

    await engine.runOnce();

    const completed = await runtime.listCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0].prUrl).toBe("https://github.com/acme/web/pull/120");
    expect(gh.comments.some((item) => item.includes("PR:\nhttps://github.com/acme/web/pull/120"))).toBe(true);
    expect(calls.some((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create")).toBe(
      true
    );
    expect(extractPrCreateBody(calls)).toContain("Closes #120");
  });

  it("requires a new PR when implementation returns a merged PR URL", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 122,
      title: "follow-up after merged pr",
      body: "please continue",
      html_url: "https://github.com/acme/web/issues/122"
    });
    const runtime = new FakeRuntimeStore();

    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "needs follow-up fix" },
      {
        summary: "done",
        root_cause: "edge case after merge",
        solution: "add more fixes",
        pr_url: "https://github.com/acme/web/pull/109",
        test_cases: []
      }
    );

    const calls: CommandCall[] = [];
    const commandRunner = async (
      command: string,
      args: string[],
      options?: { cwd?: string; input?: string }
    ): Promise<CommandResult> => {
      calls.push({ command, args, cwd: options?.cwd });

      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            state: "CLOSED",
            mergedAt: "2026-03-04T08:53:56Z",
            url: "https://github.com/acme/web/pull/109"
          }),
          stderr: ""
        };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: " M src/main.ts\n", stderr: "" };
      }
      if (command === "git" && args[0] === "add") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "commit") {
        return { code: 0, stdout: "[issue-hunter/122 1234abc] test", stderr: "" };
      }
      if (command === "git" && args[0] === "push") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (command === "git" && args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { code: 0, stdout: "1\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        return { code: 0, stdout: "https://github.com/acme/web/pull/122\n", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    };

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      commandRunner,
      prepareWorkspace: async () => ({
        contextFile: "/tmp/context.json",
        worktreePath: "/tmp/worktree",
        worktreeBranch: "issue-hunter/acme-web/122-abcd",
        worktreeCreated: true,
        cleanup: async () => undefined
      })
    });

    await engine.runOnce();

    const completed = await runtime.listCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0].prUrl).toBe("https://github.com/acme/web/pull/122");
    expect(
      calls.some(
        (call) =>
          call.command === "gh" &&
          call.args[0] === "pr" &&
          call.args[1] === "view" &&
          call.args.includes("https://github.com/acme/web/pull/109")
      )
    ).toBe(true);
    expect(calls.some((call) => call.command === "gh" && call.args[0] === "pr" && call.args[1] === "create")).toBe(
      true
    );
    expect(gh.comments.some((item) => item.includes("PR:\nhttps://github.com/acme/web/pull/122"))).toBe(true);
  });

  it("auto creates PR with Refs issue linkage when configured", async () => {
    const repo = makeRepo("repo-a", "acme", "web");
    repo.prIssueReferenceMode = "refs";
    const config = makeConfig([repo]);
    const gh = new FakeGitHubClient({
      number: 121,
      title: "missing pr url refs mode",
      body: "fix this",
      html_url: "https://github.com/acme/web/issues/121"
    });
    const runtime = new FakeRuntimeStore();

    const codex = new FakeCodexRunner(
      { needs_processing: true, reason: "valid bug" },
      {
        summary: "fixed",
        root_cause: "missing guard",
        solution: "add guard and test",
        test_cases: []
      }
    );

    const calls: CommandCall[] = [];
    const commandRunner = async (
      command: string,
      args: string[],
      options?: { cwd?: string; input?: string }
    ): Promise<CommandResult> => {
      calls.push({ command, args, cwd: options?.cwd });

      if (command === "gh" && args[0] === "pr" && args[1] === "list") {
        return { code: 0, stdout: "[]", stderr: "" };
      }
      if (command === "git" && args[0] === "status") {
        return { code: 0, stdout: " M src/main.ts\n", stderr: "" };
      }
      if (command === "git" && args[0] === "add") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "commit") {
        return { code: 0, stdout: "[issue-hunter/121 1234abc] test", stderr: "" };
      }
      if (command === "git" && args[0] === "push") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "gh" && args[0] === "repo" && args[1] === "view") {
        return { code: 0, stdout: "main\n", stderr: "" };
      }
      if (command === "git" && args[0] === "fetch") {
        return { code: 0, stdout: "", stderr: "" };
      }
      if (command === "git" && args[0] === "rev-list") {
        return { code: 0, stdout: "1\n", stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "create") {
        return { code: 0, stdout: "https://github.com/acme/web/pull/121\n", stderr: "" };
      }

      return { code: 0, stdout: "", stderr: "" };
    };

    const engine = new IssueEngine({
      getConfig: async () => config,
      runtimeStore: runtime,
      githubFactory: () => gh,
      codexFactory: () => codex,
      notifierFactory: () => null,
      writeBoard: async () => undefined,
      writeRegressionCase: async () => undefined,
      commandRunner,
      prepareWorkspace: async () => ({
        contextFile: "/tmp/context.json",
        worktreePath: "/tmp/worktree",
        worktreeBranch: "issue-hunter/acme-web/121-abcd",
        worktreeCreated: true,
        cleanup: async () => undefined
      })
    });

    await engine.runOnce();

    const completed = await runtime.listCompleted();
    expect(completed).toHaveLength(1);
    expect(completed[0].prUrl).toBe("https://github.com/acme/web/pull/121");
    expect(extractPrCreateBody(calls)).toContain("Refs #121");
    expect(extractPrCreateBody(calls)).not.toContain("Closes #121");
  });
});
