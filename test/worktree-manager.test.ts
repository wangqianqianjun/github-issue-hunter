import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorktreeManager } from "../src/core/worktree-manager.js";

describe("WorktreeManager", () => {
  it("creates worktrees under the repository local directory and unique branch names", () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "hunter-worktree-repo-"));
    const manager = new WorktreeManager();

    const first = manager.plan(repoRoot, "repo-1", 42);
    const second = manager.plan(repoRoot, "repo-1", 42);

    expect(first.path).toContain(`${repoRoot}/.worktrees/issue-42-`);
    expect(first.branch).toContain("issue-hunter/repo-1/42-");
    expect(first.branch).not.toBe(second.branch);
    expect(first.path).not.toBe(second.path);
  });
});
