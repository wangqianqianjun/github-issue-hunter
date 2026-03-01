import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ConfigStore } from "../src/core/config-store.js";
import {
  DEFAULT_IGNORE_WORDING,
  DEFAULT_IMPLEMENT_COMMAND,
  DEFAULT_IMPLEMENT_WORDING,
  DEFAULT_TRIAGE_COMMAND,
  DEFAULT_TRIAGE_WORDING
} from "../src/core/defaults.js";

describe("ConfigStore", () => {
  it("creates default config when file does not exist", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunter-config-"));
    const store = new ConfigStore(join(dir, "config.json"));

    const config = await store.load();

    expect(config.repositories).toEqual([]);
    expect(config.global.pollIntervalSeconds).toBe(30);
    expect(config.global.planMode).toBe(true);
  });

  it("upserts repository with local path and commands", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunter-config-"));
    const store = new ConfigStore(join(dir, "config.json"));

    await store.upsertRepository({
      id: "repo-1",
      owner: "acme",
      repo: "web",
      localPath: "/tmp/acme-web",
      triageCommand: "codex triage --context {context_file}",
      implementCommand: "codex implement --context {context_file}",
      triageWording: DEFAULT_TRIAGE_WORDING,
      implementWording: DEFAULT_IMPLEMENT_WORDING,
      ignoreWording: DEFAULT_IGNORE_WORDING,
      enabled: true,
      perRepoConcurrency: 1,
      slack: {
        enabled: true,
        channelId: "C123",
        transport: "chat_sdk"
      }
    });

    const config = await store.load();
    expect(config.repositories).toHaveLength(1);
    expect(config.repositories[0].repo).toBe("web");
    expect(config.repositories[0].slack.transport).toBe("chat_sdk");
  });

  it("migrates legacy codex triage/implement subcommands to codex exec defaults", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunter-config-"));
    const store = new ConfigStore(join(dir, "config.json"));

    await store.upsertRepository({
      id: "repo-legacy",
      owner: "acme",
      repo: "legacy",
      localPath: "/tmp/acme-legacy",
      triageCommand: "codex triage --context {context_file}",
      implementCommand: "codex implement --context {context_file}",
      triageWording: DEFAULT_TRIAGE_WORDING,
      implementWording: DEFAULT_IMPLEMENT_WORDING,
      ignoreWording: DEFAULT_IGNORE_WORDING,
      enabled: true,
      perRepoConcurrency: 1,
      slack: {
        enabled: false,
        channelId: "",
        transport: "none"
      }
    });

    const config = await store.load();
    expect(config.repositories[0].triageCommand).toBe(DEFAULT_TRIAGE_COMMAND);
    expect(config.repositories[0].implementCommand).toBe(DEFAULT_IMPLEMENT_COMMAND);
  });

  it("migrates old default implement command to raw-user-message default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunter-config-"));
    const store = new ConfigStore(join(dir, "config.json"));

    const oldImplementCommand =
      'codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "{worktree}" "Read the issue context JSON file at {context_file}. Implement the fix in the current repository and create/update a PR when needed. Do NOT post/edit issue comments. Do NOT close/reopen issues. Do NOT merge pull requests. Return ONLY a JSON object with fields: summary (string), root_cause (string), solution (string), pr_url (string), test_cases (array of objects with name and path)."';

    await store.upsertRepository({
      id: "repo-old-default",
      owner: "acme",
      repo: "old-default",
      localPath: "/tmp/acme-old-default",
      triageCommand: DEFAULT_TRIAGE_COMMAND,
      implementCommand: oldImplementCommand,
      triageWording: DEFAULT_TRIAGE_WORDING,
      implementWording: DEFAULT_IMPLEMENT_WORDING,
      ignoreWording: DEFAULT_IGNORE_WORDING,
      enabled: true,
      perRepoConcurrency: 1,
      slack: {
        enabled: false,
        channelId: "",
        transport: "none"
      }
    });

    const config = await store.load();
    expect(config.repositories[0].implementCommand).toBe(DEFAULT_IMPLEMENT_COMMAND);
    expect(config.repositories[0].implementCommand).toContain("{implement_user_message}");
  });

  it("migrates old json-only triage default to markdown triage default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunter-config-"));
    const store = new ConfigStore(join(dir, "config.json"));

    const oldTriageCommand =
      'codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "{worktree}" "Read the issue context JSON file at {context_file}. You MUST inspect relevant code files and tests in the current repository before deciding. Use the current repository code as source of truth. Decide whether engineering implementation is needed now. Do NOT post/edit issue comments. Do NOT close/reopen issues. Do NOT merge pull requests. Return ONLY a JSON object with fields: needs_processing (boolean), reason (string)."';

    await store.upsertRepository({
      id: "repo-old-triage-default",
      owner: "acme",
      repo: "old-triage-default",
      localPath: "/tmp/acme-old-triage-default",
      triageCommand: oldTriageCommand,
      implementCommand: DEFAULT_IMPLEMENT_COMMAND,
      triageWording: DEFAULT_TRIAGE_WORDING,
      implementWording: DEFAULT_IMPLEMENT_WORDING,
      ignoreWording: DEFAULT_IGNORE_WORDING,
      enabled: true,
      perRepoConcurrency: 1,
      slack: {
        enabled: false,
        channelId: "",
        transport: "none"
      }
    });

    const config = await store.load();
    expect(config.repositories[0].triageCommand).toBe(DEFAULT_TRIAGE_COMMAND);
    expect(config.repositories[0].triageCommand).toContain("exactly three lines");
  });

  it("migrates legacy two-line triage router command to next_step router default", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hunter-config-"));
    const store = new ConfigStore(join(dir, "config.json"));

    const oldTwoLineTriageCommand =
      'codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "{worktree}" "Read the issue context JSON file at {context_file}. You MUST inspect relevant code files and tests in the current repository before deciding. Use the current repository code as source of truth. You may use any tools/skills needed. Decide whether this issue should continue into engineering implementation right now. Output must be human-readable Chinese only, exactly two lines: 第一行: 决策: 是 或 决策: 否; 第二行: 原因: <一句话>. Do not output any other sections."';

    await store.upsertRepository({
      id: "repo-old-two-line-triage",
      owner: "acme",
      repo: "old-two-line-triage",
      localPath: "/tmp/acme-old-two-line-triage",
      triageCommand: oldTwoLineTriageCommand,
      implementCommand: DEFAULT_IMPLEMENT_COMMAND,
      triageWording: DEFAULT_TRIAGE_WORDING,
      implementWording: DEFAULT_IMPLEMENT_WORDING,
      ignoreWording: DEFAULT_IGNORE_WORDING,
      enabled: true,
      perRepoConcurrency: 1,
      slack: {
        enabled: false,
        channelId: "",
        transport: "none"
      }
    });

    const config = await store.load();
    expect(config.repositories[0].triageCommand).toBe(DEFAULT_TRIAGE_COMMAND);
    expect(config.repositories[0].triageCommand).toContain("下一步");
  });
});
