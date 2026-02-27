import { spawn } from "node:child_process";

import type { CodexRunnerLike } from "./issue-engine.js";

type CodexOutputMode = "json" | "triage";

export interface CodexRunnerOptions {
  triageCommand: string;
  implementCommand: string;
  defaultWorkingDirectory: string;
}

export class CodexRunner implements CodexRunnerLike {
  constructor(private readonly options: CodexRunnerOptions) {}

  async runTriage(
    contextFile: string,
    issueNumber: number,
    issueTitle: string,
    workingDirectory?: string,
    onProgress?: (update: string) => Promise<void> | void,
    abortSignal?: AbortSignal,
    resumeSessionId?: string
  ): Promise<Record<string, unknown>> {
    const commandTemplate = ensureResumeClausePlaceholder(this.options.triageCommand);
    return runCodexCommand(
      commandTemplate,
      {
        context_file: contextFile,
        issue_number: String(issueNumber),
        issue_title: issueTitle,
        worktree: workingDirectory ?? this.options.defaultWorkingDirectory,
        resume_clause: buildResumeClause(resumeSessionId),
        resume_session: shellQuote(String(resumeSessionId || "").trim())
      },
      workingDirectory ?? this.options.defaultWorkingDirectory,
      onProgress,
      abortSignal,
      "triage"
    );
  }

  async runImplementation(
    contextFile: string,
    issueNumber: number,
    issueTitle: string,
    originalUserMessage: string,
    workingDirectory?: string,
    onProgress?: (update: string) => Promise<void> | void,
    abortSignal?: AbortSignal,
    resumeSessionId?: string
  ): Promise<Record<string, unknown>> {
    const commandTemplate = ensureImplementUserMessagePlaceholder(
      ensureResumeClausePlaceholder(this.options.implementCommand)
    );
    const implementUserMessage = shouldInjectContextIntoImplementMessage(commandTemplate)
      ? buildContextualImplementUserMessage(contextFile, issueNumber, issueTitle, originalUserMessage)
      : originalUserMessage;
    return runCodexCommand(
      commandTemplate,
      {
        context_file: contextFile,
        issue_number: String(issueNumber),
        issue_title: issueTitle,
        worktree: workingDirectory ?? this.options.defaultWorkingDirectory,
        implement_user_message: shellQuote(implementUserMessage),
        resume_clause: buildResumeClause(resumeSessionId),
        resume_session: shellQuote(String(resumeSessionId || "").trim())
      },
      workingDirectory ?? this.options.defaultWorkingDirectory,
      onProgress,
      abortSignal,
      "json"
    );
  }
}

export function parseJsonFromOutput(output: string): Record<string, unknown> {
  const text = output.trim();
  if (!text) {
    throw new Error("Codex output is empty");
  }

  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  } catch {
    // continue fallback parsing
  }

  const blockMatch = text.match(/```json\s*([\s\S]*?)\s*```/i);
  if (blockMatch) {
    return JSON.parse(blockMatch[1]) as Record<string, unknown>;
  }

  const firstBrace = text.indexOf("{");
  if (firstBrace >= 0) {
    const candidate = text.slice(firstBrace);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // continue
    }
  }

  throw new Error("Cannot parse JSON object from Codex output");
}

export function parseTriageFromOutput(output: string): Record<string, unknown> {
  const text = output.trim();
  if (!text) {
    throw new Error("Codex triage output is empty");
  }

  try {
    const parsed = parseJsonFromOutput(text);
    if ("needs_processing" in parsed || "needsProcessing" in parsed) {
      return normalizeTriagePayload(parsed, "");
    }
  } catch {
    // Continue to markdown parsing.
  }

  const decisionSection = extractMarkdownSection(text, "Decision");
  const needsProcessing = parseNeedsProcessingValue(decisionSection || text);
  if (needsProcessing === null) {
    const shortDecision = parseChineseDecision(text);
    if (shortDecision !== null) {
      return {
        needs_processing: shortDecision,
        reason: extractShortReasonLine(text),
        markdown: text
      };
    }
    throw new Error("Cannot parse needs_processing from triage output");
  }

  return {
    needs_processing: needsProcessing,
    reason: extractMarkdownSection(text, "Reason") || extractShortReasonLine(text),
    analysis: extractMarkdownSection(text, "Analysis"),
    evidence: extractMarkdownSection(text, "Evidence"),
    markdown: text
  };
}

export function shouldInjectContextIntoImplementMessage(commandTemplate: string): boolean {
  const text = String(commandTemplate || "").trim();
  if (!text) {
    return false;
  }
  if (!/^codex\s+exec\b/i.test(text)) {
    return false;
  }
  if (text.includes("{context_file}")) {
    return false;
  }
  return true;
}

export function buildContextualImplementUserMessage(
  contextFile: string,
  issueNumber: number,
  issueTitle: string,
  originalUserMessage: string
): string {
  const issueNum = Number.isFinite(issueNumber) ? String(issueNumber) : "unknown";
  const title = String(issueTitle || "").trim();
  const userMessage = String(originalUserMessage || "").trim() || "(empty user message)";
  const contextPath = String(contextFile || "").trim();

  const header = title ? `GitHub issue #${issueNum}: ${title}` : `GitHub issue #${issueNum}`;
  return [
    "[System context for this turn]",
    `You are continuing work for ${header}.`,
    `First read the issue context JSON file: ${contextPath}`,
    "Then use the issue context and current repository code as the source of truth.",
    "Process the ORIGINAL user message below in this same issue context.",
    "Do not ask detached scoping questions that ignore the issue context.",
    "",
    "[Original user message]",
    userMessage
  ].join("\n");
}

export function parseImplementationFromOutput(output: string): Record<string, unknown> {
  const text = output.trim();
  if (!text) {
    throw new Error("Codex implementation output is empty");
  }

  const summary = extractFirstNonEmpty(
    extractMarkdownSectionAny(text, ["Summary", "摘要", "总结", "概述"]),
    extractLabeledValue(text, ["Summary", "摘要", "总结", "概述"])
  );
  const rootCause = extractFirstNonEmpty(
    extractMarkdownSectionAny(text, ["RootCause", "Root Cause", "原因", "根因"]),
    extractLabeledValue(text, ["RootCause", "Root Cause", "原因", "根因"])
  );
  const solution = extractFirstNonEmpty(
    extractMarkdownSectionAny(text, ["Solution", "解决方案", "修复方案", "方案"]),
    extractLabeledValue(text, ["Solution", "解决方案", "修复方案", "方案"])
  );
  const prUrl = extractPrUrl(text);

  if (summary || rootCause || solution) {
    return {
      summary: summary || inferSummary(text),
      root_cause: rootCause,
      solution: solution || inferSolution(text),
      pr_url: prUrl,
      test_cases: []
    };
  }

  // Fallback only: accept JSON output when text/markdown extraction cannot find fields.
  try {
    const parsed = parseJsonFromOutput(text);
    return normalizeImplementationPayload(parsed, text);
  } catch {
    return {
      summary: inferSummary(text),
      root_cause: "",
      solution: inferSolution(text),
      pr_url: extractPrUrl(text),
      test_cases: []
    };
  }
}

async function runCodexCommand(
  template: string,
  replacements: Record<string, string>,
  workingDirectory: string,
  onProgress?: (update: string) => Promise<void> | void,
  abortSignal?: AbortSignal,
  outputMode: CodexOutputMode = "json"
): Promise<Record<string, unknown>> {
  const command = template.replaceAll(/\{([a-z_]+)\}/g, (_, key: string) => replacements[key] ?? "");
  const result = await runShell(command, workingDirectory, onProgress, abortSignal);
  if (result.aborted) {
    throw new Error("Codex command cancelled by stop request");
  }
  if (result.code !== 0) {
    throw new Error(`Codex command failed (${result.code}): ${result.stderr || result.stdout}`);
  }

  if (outputMode === "triage") {
    if (result.lastAgentMessage) {
      return withCodexSessionId(parseTriageFromOutput(result.lastAgentMessage), result.codexThreadId);
    }
    if (result.eventResult) {
      return withCodexSessionId(normalizeTriagePayload(result.eventResult, ""), result.codexThreadId);
    }
    return withCodexSessionId(parseTriageFromOutput(result.stdout || result.stderr), result.codexThreadId);
  }

  if (outputMode === "json") {
    const text = result.lastAgentMessage || result.stdout || result.stderr;
    return withCodexSessionId(parseImplementationFromOutput(text), result.codexThreadId);
  }

  if (result.eventResult) {
    return result.eventResult;
  }
  return parseJsonFromOutput(result.stdout || result.stderr);
}

async function runShell(
  command: string,
  cwd: string,
  onProgress?: (update: string) => Promise<void> | void,
  abortSignal?: AbortSignal
): Promise<{
  code: number;
  stdout: string;
  stderr: string;
  eventResult: Record<string, unknown> | null;
  lastAgentMessage: string;
  codexThreadId: string;
  aborted: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let eventResult: Record<string, unknown> | null = null;
    let lastAgentMessage = "";
    let codexThreadId = "";
    let lastProgressMessage = "";
    let stdoutLineBuffer = "";
    let aborted = false;
    let forceKillTimer: NodeJS.Timeout | null = null;

    const emitProgress = async (text: string) => {
      if (!onProgress) {
        return;
      }
      try {
        if (text === lastProgressMessage) {
          return;
        }
        await onProgress(text);
        lastProgressMessage = text;
      } catch {
        // Progress callback failures must not interrupt codex execution.
      }
    };

    const killChild = () => {
      if (aborted) {
        return;
      }
      aborted = true;
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, 5000);
    };

    if (abortSignal) {
      if (abortSignal.aborted) {
        killChild();
      } else {
        abortSignal.addEventListener("abort", killChild, { once: true });
      }
    }

    const processEventLine = async (line: string) => {
      const event = tryParseEvent(line);
      if (!event) {
        return;
      }

      const eventType = String(event.type || "");
      if (eventType === "thread.started") {
        const threadId = String(event.thread_id ?? event.threadId ?? "").trim();
        if (threadId) {
          codexThreadId = threadId;
        }
        await emitProgress("System: Codex 会话已启动");
        return;
      }

      if (eventType === "turn.started") {
        await emitProgress("System: Codex 开始处理请求");
        return;
      }

      if (eventType === "turn.completed") {
        return;
      }

      if (eventType === "item.completed") {
        const item = (event.item ?? {}) as Record<string, unknown>;
        const itemType = String(item.type ?? "");
        if (itemType === "reasoning") {
          const text = normalizeReasoningText(String(item.text ?? ""));
          if (text) {
            await emitProgress(`Assistant: 🧠 ${text}`);
          }
          return;
        }

        if (itemType === "agent_message") {
          const text = String(item.text ?? "").trim();
          if (!text) {
            return;
          }
          lastAgentMessage = text;
          const progressText = buildAssistantProgressText(text);
          if (progressText) {
            await emitProgress(`Assistant: ${progressText}`);
          }
          try {
            eventResult = parseJsonFromOutput(text);
          } catch {
            // Non-JSON assistant text is ignored; fallback parser uses full stdout.
          }
          return;
        }
      }

      if (eventType === "turn.failed" || eventType === "error") {
        const message = String((event.error as Record<string, unknown>)?.message ?? event.message ?? "").trim();
        if (message) {
          await emitProgress(`System: Codex 报告异常: ${message}`);
        }
      }
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      stdoutLineBuffer += text;
      void drainStdoutBuffer();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", killChild);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      reject(error);
    });

    const drainStdoutBuffer = async () => {
      let idx = stdoutLineBuffer.indexOf("\n");
      while (idx >= 0) {
        const line = stdoutLineBuffer.slice(0, idx).trim();
        stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
        if (line) {
          await processEventLine(line);
        }
        idx = stdoutLineBuffer.indexOf("\n");
      }
    };

    child.on("close", async (code) => {
      if (abortSignal) {
        abortSignal.removeEventListener("abort", killChild);
      }
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
      }
      const tail = stdoutLineBuffer.trim();
      if (tail) {
        await processEventLine(tail);
      }
      resolve({
        code: aborted ? 130 : code ?? 1,
        stdout,
        stderr,
        eventResult,
        lastAgentMessage,
        codexThreadId,
        aborted
      });
    });
  });
}

function normalizeTriagePayload(payload: Record<string, unknown>, markdown: string): Record<string, unknown> {
  const needsProcessing =
    parseNeedsProcessingValue(payload.needs_processing) ?? parseNeedsProcessingValue(payload.needsProcessing) ?? false;

  return {
    ...payload,
    needs_processing: needsProcessing,
    reason: String(payload.reason ?? "").trim(),
    markdown
  };
}

function parseNeedsProcessingValue(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
    if (normalized === "yes" || normalized === "是") {
      return true;
    }
    if (normalized === "no" || normalized === "否") {
      return false;
    }

    const match = normalized.match(/needs_processing\s*:\s*(true|false)\b/);
    if (match) {
      return match[1] === "true";
    }

    const chineseMatch = normalized.match(/(?:决策|decision)\s*[:：]\s*(是|否|yes|no)/i);
    if (chineseMatch) {
      return chineseMatch[1].toLowerCase() === "是" || chineseMatch[1].toLowerCase() === "yes";
    }
  }
  return null;
}

function extractMarkdownSection(markdown: string, heading: string): string {
  const escaped = escapeRegExp(heading);
  const pattern = new RegExp(`^##+\\s*${escaped}\\s*$([\\s\\S]*?)(?=^##+\\s+|\\Z)`, "im");
  const match = markdown.match(pattern);
  if (!match) {
    return "";
  }
  return match[1].trim();
}

function extractMarkdownSectionAny(markdown: string, headings: string[]): string {
  for (const heading of headings) {
    const section = extractMarkdownSection(markdown, heading);
    if (section) {
      return section;
    }
  }
  return "";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseChineseDecision(text: string): boolean | null {
  const decisionLine = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  if (!decisionLine) {
    return null;
  }

  const normalized = decisionLine.toLowerCase();
  if (normalized.includes("决策") || normalized.includes("decision")) {
    const match = normalized.match(/[:：]\s*(是|否|yes|no)/i);
    if (match) {
      return match[1].toLowerCase() === "是" || match[1].toLowerCase() === "yes";
    }
  }

  if (normalized === "是" || normalized === "yes") {
    return true;
  }
  if (normalized === "否" || normalized === "no") {
    return false;
  }

  return null;
}

function extractShortReasonLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => /^(原因|reason)\s*[:：]/i.test(item));

  if (!line) {
    return "";
  }

  return line.replace(/^(原因|reason)\s*[:：]\s*/i, "").trim();
}

function extractLabeledValue(text: string, labels: string[]): string {
  const escaped = labels.map((label) => escapeRegExp(label)).join("|");
  const pattern = new RegExp(`^(?:${escaped})\\s*[:：]\\s*(.+)$`, "im");
  const match = text.match(pattern);
  if (!match) {
    return "";
  }
  return String(match[1] || "").trim();
}

function extractFirstNonEmpty(...items: string[]): string {
  for (const item of items) {
    const value = String(item || "").trim();
    if (value) {
      return value;
    }
  }
  return "";
}

function extractPrUrl(text: string): string {
  const match = text.match(/https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/i);
  return match ? match[0] : "";
}

function inferSummary(text: string): string {
  const compact = String(text || "").trim();
  if (!compact) {
    return "";
  }
  const firstParagraph = compact.split(/\n\s*\n/)[0]?.trim() || compact;
  return truncate(firstParagraph.replace(/\s+/g, " "), 600);
}

function inferSolution(text: string): string {
  const compact = String(text || "").trim();
  if (!compact) {
    return "";
  }
  return truncate(compact, 1600);
}

function normalizeImplementationPayload(payload: Record<string, unknown>, markdown: string): Record<string, unknown> {
  return {
    ...payload,
    summary: String(payload.summary ?? inferSummary(markdown)).trim(),
    root_cause: String(payload.root_cause ?? payload.rootCause ?? "").trim(),
    solution: String(payload.solution ?? inferSolution(markdown)).trim(),
    pr_url: String(payload.pr_url ?? payload.prUrl ?? extractPrUrl(markdown)).trim(),
    test_cases: Array.isArray(payload.test_cases)
      ? payload.test_cases
      : Array.isArray(payload.testCases)
        ? payload.testCases
        : []
  };
}

function ensureImplementUserMessagePlaceholder(template: string): string {
  const text = String(template || "").trim();
  if (!text) {
    return "{implement_user_message}";
  }
  if (text.includes("{implement_user_message}")) {
    return text;
  }
  return `${text} {implement_user_message}`;
}

function ensureResumeClausePlaceholder(template: string): string {
  const text = String(template || "").trim();
  if (!text) {
    return "{resume_clause}";
  }
  if (text.includes("{resume_clause}")) {
    return text;
  }
  if (/\bresume\b/i.test(text)) {
    return text;
  }
  if (!/^codex\s+exec\b/i.test(text)) {
    return text;
  }

  const withCd = text.replace(
    /(--cd\s+(?:"[^"]*"|'[^']*'|\S+))/i,
    "$1 {resume_clause}"
  );
  if (withCd !== text) {
    return withCd;
  }
  return `${text} {resume_clause}`;
}

function buildResumeClause(resumeSessionId?: string): string {
  const value = String(resumeSessionId || "").trim();
  if (!value) {
    return "";
  }
  return `resume ${shellQuote(value)}`;
}

function shellQuote(input: string): string {
  const text = String(input ?? "");
  if (!text) {
    return "''";
  }
  return `'${text.replace(/'/g, `'\"'\"'`)}'`;
}

function withCodexSessionId(payload: Record<string, unknown>, sessionId: string): Record<string, unknown> {
  const value = String(sessionId || "").trim();
  if (!value) {
    return payload;
  }
  return {
    ...payload,
    codex_session_id: value
  };
}

function tryParseEvent(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (!("type" in parsed)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function normalizeReasoningText(text: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "";
  }

  const markdownBoldLine = /^\*\*(.+)\*\*$/s;
  const match = trimmed.match(markdownBoldLine);
  if (match) {
    return match[1].trim();
  }
  return trimmed;
}

function buildAssistantProgressText(text: string): string {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return "";
  }

  try {
    parseJsonFromOutput(trimmed);
    return "已返回结构化结果，正在解析。";
  } catch {
    // Keep human-readable markdown/text output.
  }

  return truncate(trimmed.replace(/\n{3,}/g, "\n\n"), 700);
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 3))}...`;
}
