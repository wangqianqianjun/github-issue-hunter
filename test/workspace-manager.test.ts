import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";

import { WorkspaceManager } from "../src/core/workspace-manager.js";
import type { RepositoryConfig } from "../src/types/config.js";

const makeRepo = (localPath: string): RepositoryConfig => ({
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
    enabled: false,
    channelId: "",
    transport: "none"
  }
});

describe("WorkspaceManager", () => {
  it("writes context file under workspace artifacts directory", async () => {
    const root = mkdtempSync(join(tmpdir(), "hunter-workspace-"));
    const repoRoot = join(root, "repo");
    mkdirSync(repoRoot, { recursive: true });
    execSync(`git -C "${repoRoot}" init`, { stdio: "ignore" });
    execSync(`git -C "${repoRoot}" config user.email "issue-hunter@example.com"`, { stdio: "ignore" });
    execSync(`git -C "${repoRoot}" config user.name "Issue Hunter"`, { stdio: "ignore" });
    writeFileSync(join(repoRoot, ".seed"), "seed\n", "utf8");
    execSync(`git -C "${repoRoot}" add .`, { stdio: "ignore" });
    execSync(`git -C "${repoRoot}" commit -m "seed"`, { stdio: "ignore" });
    const workspaceRoot = join(root, "workspace");
    const manager = new WorkspaceManager({
      workspaceRoot,
      keepWorktrees: false
    });

    const repo = makeRepo(repoRoot);
    const issue = { number: 42, title: "test issue", body: "test body" };
    const cleanupPaths: string[] = [];
    try {
      const prepared = await manager.prepare(
        repo,
        issue,
        [],
        [],
        {
          listOpenIssues: async () => [],
          getIssue: async () => ({}),
          listIssueComments: async () => [],
          createIssueComment: async () => undefined,
          closeIssue: async () => undefined
        }
      );
      cleanupPaths.push(prepared.contextFile);

      expect(prepared.contextFile.startsWith(workspaceRoot)).toBe(true);
      expect(prepared.contextFile.includes("/artifacts/")).toBe(true);
      expect(prepared.contextFile.includes(".issue-hunter")).toBe(false);
      await prepared.cleanup();
    } finally {
      for (const path of cleanupPaths) {
        rmSync(path, { force: true });
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});
