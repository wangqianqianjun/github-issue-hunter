import { describe, expect, it } from "vitest";
import { IssueEngine } from "../src/core/issue-engine.js";
class FakeGitHubClient {
    issue;
    comments = [];
    closed = [];
    constructor(issue) {
        this.issue = issue;
    }
    async listOpenIssues() {
        return [this.issue];
    }
    async getIssue(issueNumber) {
        if (issueNumber !== this.issue.number) {
            throw new Error("issue mismatch");
        }
        return this.issue;
    }
    async listIssueComments() {
        return [];
    }
    async createIssueComment(_issueNumber, body) {
        this.comments.push(body);
    }
    async closeIssue(issueNumber) {
        this.closed.push(issueNumber);
    }
    async downloadImages() {
        return [];
    }
}
class FakeCodexRunner {
    triageResult;
    implementResult;
    constructor(triageResult, implementResult) {
        this.triageResult = triageResult;
        this.implementResult = implementResult;
    }
    async runTriage() {
        return this.triageResult;
    }
    async runImplementation() {
        return this.implementResult;
    }
}
class FakeRuntimeStore {
    seen = new Set();
    records = [];
    async isSeen(issueKey) {
        return this.seen.has(issueKey);
    }
    async markSeen(issueKey) {
        this.seen.add(issueKey);
    }
    async saveRecord(record) {
        const idx = this.records.findIndex((item) => item.issueKey === record.issueKey);
        if (idx >= 0) {
            this.records[idx] = record;
            return;
        }
        this.records.push(record);
    }
    async listCompleted() {
        return this.records.filter((item) => item.state === "completed");
    }
}
const makeRepo = (id, owner, repo) => ({
    id,
    owner,
    repo,
    localPath: `/tmp/${owner}-${repo}`,
    githubTokenEnv: "GITHUB_TOKEN",
    triageCommand: "triage {context_file}",
    implementCommand: "implement {context_file}",
    enabled: true,
    perRepoConcurrency: 1,
    slack: {
        enabled: false,
        channelId: "",
        transport: "none"
    }
});
const makeConfig = (repositories) => ({
    repositories,
    global: {
        pollIntervalSeconds: 30,
        globalConcurrency: 2,
        workspaceDir: ".",
        closeIssueOnDone: true,
        keepWorktrees: false
    },
    slackApp: {
        enabled: false,
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
                return new FakeCodexRunner({ needs_processing: true, reason: "valid bug" }, {
                    summary: "parser nil pointer",
                    root_cause: "missing nil check",
                    solution: "add guard and tests",
                    pr_url: "https://github.com/acme/api/pull/88",
                    test_cases: [{ name: "parser nil", path: "tests/parser.test.ts" }]
                });
            },
            notifierFactory: () => null,
            writeBoard: async () => undefined,
            writeRegressionCase: async () => undefined,
            prepareWorkspace: async () => ({ contextFile: "/tmp/context.json", cleanup: async () => undefined })
        });
        await engine.runOnce();
        expect(ghA.comments).toEqual(["正在评估", "暂无计划处理。"]);
        expect(ghB.comments).toContain("已经进入排班计划，正在处理。");
        expect(ghB.comments.some((line) => line.includes("RootCause"))).toBe(true);
        expect(ghB.closed).toEqual([12]);
        const completed = await runtime.listCompleted();
        expect(completed).toHaveLength(1);
        expect(completed[0].prUrl).toContain("/pull/88");
    });
    it("skips duplicate issue when already seen", async () => {
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
});
