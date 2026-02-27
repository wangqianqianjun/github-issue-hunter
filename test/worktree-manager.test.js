import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorktreeManager } from "../src/core/worktree-manager.js";
describe("WorktreeManager", () => {
    it("creates deterministic prefix and unique branch names", () => {
        const root = mkdtempSync(join(tmpdir(), "hunter-worktree-"));
        const manager = new WorktreeManager(root);
        const first = manager.plan("repo-1", 42);
        const second = manager.plan("repo-1", 42);
        expect(first.path).toContain("repo-1");
        expect(first.branch).toContain("issue-hunter/repo-1/42-");
        expect(first.branch).not.toBe(second.branch);
        expect(first.path).not.toBe(second.path);
    });
});
