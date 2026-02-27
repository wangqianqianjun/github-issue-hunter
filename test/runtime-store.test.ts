import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { FileRuntimeStore } from "../src/core/runtime-store.js";
import type { IssueExecutionRecord } from "../src/types/config.js";

describe("FileRuntimeStore", () => {
  it("preserves records under concurrent writers", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-runtime-store-"));
    try {
      const filePath = join(root, "runtime", "issues.json");
      const storeA = new FileRuntimeStore(filePath);
      const storeB = new FileRuntimeStore(filePath);

      const makeRecord = (issueKey: string, issueNumber: number): IssueExecutionRecord => ({
        issueKey,
        repoId: "repo",
        issueNumber,
        state: "triaging",
        summary: "",
        prUrl: "",
        rootCause: "",
        solution: "",
        closedAt: "",
        threadTs: "",
        updatedAt: new Date().toISOString()
      });

      const writesA = Array.from({ length: 25 }, (_, idx) =>
        storeA.saveRecord(makeRecord(`acme/web#${100 + idx}`, 100 + idx))
      );
      const writesB = Array.from({ length: 25 }, (_, idx) =>
        storeB.saveRecord(makeRecord(`acme/api#${200 + idx}`, 200 + idx))
      );

      await Promise.all([...writesA, ...writesB]);

      const all = await storeA.listAll();
      expect(all).toHaveLength(50);
      expect(new Set(all.map((item) => item.issueKey)).size).toBe(50);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves seen issue keys under concurrent markSeen calls", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-runtime-seen-"));
    try {
      const filePath = join(root, "runtime", "issues.json");
      const storeA = new FileRuntimeStore(filePath);
      const storeB = new FileRuntimeStore(filePath);

      const keys = Array.from({ length: 30 }, (_, idx) => `acme/web#${idx + 1}`);
      await Promise.all(
        keys.map((key, idx) => (idx % 2 === 0 ? storeA.markSeen(key) : storeB.markSeen(key)))
      );

      const checks = await Promise.all(keys.map((key) => storeA.isSeen(key)));
      expect(checks.every(Boolean)).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

