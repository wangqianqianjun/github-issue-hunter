import { chmod, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { detectAvailableAgentClis, resolveAgentBinary } from "../src/clients/agent-detect.js";

describe("agent-detect", () => {
  it("recommends codex when both codex and claude are available", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-agent-detect-"));
    const previousPath = process.env.PATH;
    try {
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      await createFakeExecutable(join(bin, "codex"));
      await createFakeExecutable(join(bin, "claude"));
      process.env.PATH = bin;

      const detected = detectAvailableAgentClis();
      expect(detected.codex.found).toBe(true);
      expect(detected.claude.found).toBe(true);
      expect(detected.recommendedBackend).toBe("codex");
    } finally {
      if (typeof previousPath === "string") {
        process.env.PATH = previousPath;
      } else {
        delete process.env.PATH;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("recommends claude when claude is available and codex is unavailable", async () => {
    const root = await mkdtemp(join(tmpdir(), "issue-hunter-agent-detect-"));
    const previousPath = process.env.PATH;
    try {
      const bin = join(root, "bin");
      await mkdir(bin, { recursive: true });
      await createFakeExecutable(join(bin, "claude"));
      process.env.PATH = bin;

      const detected = detectAvailableAgentClis();
      expect(detected.claude.found).toBe(true);
      if (detected.codex.found) {
        expect(detected.recommendedBackend).toBe("codex");
      } else {
        expect(detected.recommendedBackend).toBe("claude");
      }
    } finally {
      if (typeof previousPath === "string") {
        process.env.PATH = previousPath;
      } else {
        delete process.env.PATH;
      }
      await rm(root, { recursive: true, force: true });
    }
  });

  it("uses env override when resolving codex binary", () => {
    const previous = process.env.ISSUE_HUNTER_CODEX_BIN;
    process.env.ISSUE_HUNTER_CODEX_BIN = "/tmp/custom-codex";
    try {
      expect(resolveAgentBinary("codex")).toBe("/tmp/custom-codex");
    } finally {
      if (typeof previous === "string") {
        process.env.ISSUE_HUNTER_CODEX_BIN = previous;
      } else {
        delete process.env.ISSUE_HUNTER_CODEX_BIN;
      }
    }
  });
});

async function createFakeExecutable(path: string): Promise<void> {
  await writeFile(path, "#!/bin/sh\nexit 0\n", "utf8");
  await chmod(path, 0o755);
}
