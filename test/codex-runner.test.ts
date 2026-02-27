import { describe, expect, it } from "vitest";

import {
  buildContextualImplementUserMessage,
  CodexRunner,
  parseImplementationFromOutput,
  parseJsonFromOutput,
  parseTriageFromOutput,
  shouldInjectContextIntoImplementMessage
} from "../src/core/codex-runner.js";

describe("parseJsonFromOutput", () => {
  it("parses raw json", () => {
    expect(parseJsonFromOutput('{"needs_processing": true}').needs_processing).toBe(true);
  });

  it("parses fenced json", () => {
    const payload = parseJsonFromOutput('before\n```json\n{"summary":"ok"}\n```');
    expect(payload.summary).toBe("ok");
  });

  it("throws for invalid output", () => {
    expect(() => parseJsonFromOutput("invalid")).toThrowError();
  });
});

describe("parseTriageFromOutput", () => {
  it("parses markdown decision and sections", () => {
    const triage = parseTriageFromOutput(`
## Decision
needs_processing: true

## Reason
Null option is missing in filter UI.

## Analysis
Checked parser and filter value list.

## Evidence
src/filter.ts
`);

    expect(triage.needs_processing).toBe(true);
    expect(triage.reason).toContain("Null option");
    expect(triage.markdown).toContain("## Decision");
  });

  it("parses json triage response as fallback", () => {
    const triage = parseTriageFromOutput('{"needs_processing": false, "reason": "out of scope"}');
    expect(triage.needs_processing).toBe(false);
    expect(triage.reason).toBe("out of scope");
  });

  it("throws when needs_processing is missing", () => {
    expect(() => parseTriageFromOutput("## Decision\npending")).toThrowError();
  });

  it("parses short chinese yes/no format", () => {
    const triage = parseTriageFromOutput("决策: 是\n原因: 该问题可复现且尚未覆盖。");
    expect(triage.needs_processing).toBe(true);
    expect(triage.reason).toContain("可复现");
  });
});

describe("parseImplementationFromOutput", () => {
  it("parses markdown implementation sections first", () => {
    const result = parseImplementationFromOutput(`
## Summary
Added memory index support.

## RootCause
The previous implementation had no long-term memory archive strategy.

## Solution
Added memory.md rotation and search mechanism.

PR:
https://github.com/acme/web/pull/123
`);

    expect(result.summary).toContain("memory index support");
    expect(result.root_cause).toContain("no long-term memory");
    expect(result.solution).toContain("memory.md rotation");
    expect(result.pr_url).toContain("/pull/123");
  });

  it("falls back to json when markdown fields are missing", () => {
    const result = parseImplementationFromOutput(
      '{"summary":"ok","root_cause":"na","solution":"done","pr_url":"https://github.com/acme/web/pull/10"}'
    );
    expect(result.summary).toBe("ok");
    expect(result.pr_url).toContain("/pull/10");
  });
});

describe("CodexRunner event relay", () => {
  it("does not emit tool-call progress updates", async () => {
    const script = [
      "const events = [",
      '{ type: "thread.started", thread_id: "ses_triage_1" },',
      '{ type: "turn.started" },',
      '{ type: "item.completed", item: { type: "command_execution", command: "npm test", status: "completed" } },',
      '{ type: "item.completed", item: { type: "reasoning", text: "triage thinking" } },',
      '{ type: "item.completed", item: { type: "agent_message", text: "## Decision\\\\nneeds_processing: false\\\\n\\\\n## Reason\\\\nout of scope" } },',
      '{ type: "turn.completed" }',
      "];",
      "for (const event of events) console.log(JSON.stringify(event));"
    ].join("");

    const runner = new CodexRunner({
      triageCommand: `node -e '${script}'`,
      implementCommand: `node -e '${script}'`,
      defaultWorkingDirectory: process.cwd()
    });

    const updates: string[] = [];
    const triage = await runner.runTriage("/tmp/context.json", 1, "test issue", process.cwd(), (update) => {
      updates.push(update);
    });

    expect(triage.needs_processing).toBe(false);
    expect(triage.codex_session_id).toBe("ses_triage_1");
    expect(updates.some((line) => line.includes("Tool:"))).toBe(false);
    expect(updates.some((line) => line.includes("Assistant: 🧠 triage thinking"))).toBe(true);
    expect(updates.some((line) => line.includes("System: Codex 会话已启动"))).toBe(true);
    expect(updates.some((line) => line.includes("Assistant: ## Decision"))).toBe(true);
    expect(updates.some((line) => line.includes("本轮处理完成"))).toBe(false);
  });
});

describe("CodexRunner implementation raw message", () => {
  it("passes original user message directly to codex command", async () => {
    const script =
      "const message = process.argv[1] || ''; console.log(JSON.stringify({ summary: message, root_cause: '', solution: '', pr_url: '', test_cases: [] }));";

    const runner = new CodexRunner({
      triageCommand: "echo '{\"needs_processing\":false}'",
      implementCommand: `node -e ${JSON.stringify(script)} {implement_user_message}`,
      defaultWorkingDirectory: process.cwd()
    });

    const originalMessage = '用户反馈: "还是有问题"，请继续处理';
    const result = await runner.runImplementation(
      "/tmp/context.json",
      1,
      "test issue",
      originalMessage,
      process.cwd()
    );

    expect(result.summary).toBe(originalMessage);
  });

  it("injects issue context when codex implement command misses context placeholder", () => {
    const command = "codex exec --json --cd \"{worktree}\" {implement_user_message}";
    expect(shouldInjectContextIntoImplementMessage(command)).toBe(true);

    const prompt = buildContextualImplementUserMessage(
      "/tmp/context.json",
      148,
      "memory design discussion",
      "我们能否一起来讨论下设计方案"
    );

    expect(prompt).toContain("GitHub issue #148");
    expect(prompt).toContain("/tmp/context.json");
    expect(prompt).toContain("讨论下设计方案");
  });

  it("does not inject issue context for non-codex custom implement commands", () => {
    const command = "node scripts/runner.js {implement_user_message}";
    expect(shouldInjectContextIntoImplementMessage(command)).toBe(false);
  });

  it("does not inject issue context when command already includes context_file placeholder", () => {
    const command = "codex exec --json --cd \"{worktree}\" \"read {context_file}\" {implement_user_message}";
    expect(shouldInjectContextIntoImplementMessage(command)).toBe(false);
  });

  it("captures codex session id from thread.started event in implementation", async () => {
    const script = [
      "const events = [",
      '{ type: "thread.started", thread_id: "ses_impl_1" },',
      '{ type: "turn.started" },',
      '{ type: "item.completed", item: { type: "agent_message", text: "## Summary\\\\nimplemented\\\\n\\\\n## Solution\\\\nfixed" } },',
      '{ type: "turn.completed" }',
      "];",
      "for (const event of events) console.log(JSON.stringify(event));"
    ].join("");

    const runner = new CodexRunner({
      triageCommand: "echo '{\"needs_processing\":false}'",
      implementCommand: `node -e '${script}'`,
      defaultWorkingDirectory: process.cwd()
    });

    const result = await runner.runImplementation(
      "/tmp/context.json",
      1,
      "test issue",
      "please continue",
      process.cwd()
    );

    expect(result.codex_session_id).toBe("ses_impl_1");
    expect(String(result.summary || "")).toContain("implemented");
  });
});
