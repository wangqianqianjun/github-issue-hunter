import { accessSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";

import type { AgentBackend } from "../types/config.js";

export interface CliDetection {
  command: string;
  found: boolean;
  path: string;
}

export interface AgentCliDetection {
  codex: CliDetection;
  claude: CliDetection;
  availableBackends: AgentBackend[];
  recommendedBackend: AgentBackend;
}

export function detectAgentCli(binary: string): CliDetection {
  const normalized = String(binary || "").trim();
  if (!normalized) {
    return { command: "", found: false, path: "" };
  }

  if (normalized === "claude") {
    const preferredClaudePath = join(homedir(), ".claude", "local", "claude");
    if (isExecutableFile(preferredClaudePath)) {
      return { command: normalized, found: true, path: preferredClaudePath };
    }
  }

  const fromPath = findExecutableInPath(normalized, process.env.PATH);
  if (fromPath) {
    return { command: normalized, found: true, path: fromPath };
  }

  const commonCandidates =
    normalized === "codex"
      ? ["/opt/homebrew/bin/codex", "/usr/local/bin/codex"]
      : ["/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  for (const candidate of commonCandidates) {
    if (isExecutableFile(candidate)) {
      return { command: normalized, found: true, path: candidate };
    }
  }

  return { command: normalized, found: false, path: "" };
}

export function detectAvailableAgentClis(): AgentCliDetection {
  const codex = detectAgentCli("codex");
  const claude = detectAgentCli("claude");
  const availableBackends: AgentBackend[] = [];
  if (codex.found) {
    availableBackends.push("codex");
  }
  if (claude.found) {
    availableBackends.push("claude");
  }

  return {
    codex,
    claude,
    availableBackends,
    recommendedBackend: pickRecommendedBackend(codex.found, claude.found)
  };
}

export function resolveAgentBinary(backend: AgentBackend): string {
  const normalized = backend === "claude" ? "claude" : "codex";
  const issueHunterEnvName = normalized === "claude" ? "ISSUE_HUNTER_CLAUDE_BIN" : "ISSUE_HUNTER_CODEX_BIN";
  const genericEnvName = normalized === "claude" ? "CLAUDE_BIN" : "CODEX_BIN";

  const issueHunterOverride = String(process.env[issueHunterEnvName] || "").trim();
  if (issueHunterOverride) {
    return issueHunterOverride;
  }

  const genericOverride = String(process.env[genericEnvName] || "").trim();
  if (genericOverride) {
    return genericOverride;
  }

  const detected = detectAgentCli(normalized);
  if (detected.found && detected.path) {
    return detected.path;
  }

  return normalized;
}

export function normalizeAgentBackend(value: unknown): AgentBackend | null {
  const normalized = String(value || "")
    .trim()
    .toLowerCase();
  if (normalized === "claude") {
    return "claude";
  }
  if (normalized === "codex") {
    return "codex";
  }
  return null;
}

function pickRecommendedBackend(hasCodex: boolean, hasClaude: boolean): AgentBackend {
  if (hasCodex && hasClaude) {
    return "codex";
  }
  if (hasCodex) {
    return "codex";
  }
  if (hasClaude) {
    return "claude";
  }
  return "codex";
}

function findExecutableInPath(binary: string, pathValue: string | undefined): string {
  const entries = String(pathValue || "")
    .split(delimiter)
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  for (const entry of entries) {
    const candidate = join(entry, binary);
    if (isExecutableFile(candidate)) {
      return candidate;
    }
  }

  return "";
}

function isExecutableFile(path: string): boolean {
  const normalized = String(path || "").trim();
  if (!normalized) {
    return false;
  }

  try {
    accessSync(normalized, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}
