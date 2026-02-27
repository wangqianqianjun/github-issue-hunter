import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import type { AppConfig, RepositoryConfig } from "../types/config.js";
import {
  DEFAULT_IGNORE_WORDING,
  DEFAULT_IMPLEMENT_COMMAND,
  DEFAULT_IMPLEMENT_WORDING,
  DEFAULT_TRIAGE_COMMAND,
  DEFAULT_TRIAGE_WORDING
} from "./defaults.js";

const DEFAULT_CONFIG: AppConfig = {
  repositories: [],
  global: {
    pollIntervalSeconds: 30,
    globalConcurrency: 2,
    workspaceDir: ".",
    closeIssueOnDone: false,
    keepWorktrees: false
  },
  slackApp: {
    enabled: false,
    botToken: "",
    appToken: "",
    signingSecret: "",
    clientId: "",
    clientSecret: "",
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
};

export class ConfigStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AppConfig> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as AppConfig;
      return normalizeConfig(parsed);
    } catch {
      const normalized = normalizeConfig(undefined);
      await this.save(normalized);
      return normalized;
    }
  }

  async save(config: AppConfig): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(config, null, 2), "utf8");
  }

  async upsertRepository(repo: RepositoryConfig): Promise<void> {
    const config = await this.load();
    const idx = config.repositories.findIndex((item) => item.id === repo.id);
    if (idx >= 0) {
      config.repositories[idx] = normalizeRepository(repo);
    } else {
      config.repositories.push(normalizeRepository(repo));
    }
    await this.save(config);
  }

  async removeRepository(id: string): Promise<void> {
    const config = await this.load();
    config.repositories = config.repositories.filter((item) => item.id !== id);
    await this.save(config);
  }

  async updateSlackApp(patch: Partial<AppConfig["slackApp"]>): Promise<void> {
    const config = await this.load();
    config.slackApp = {
      ...config.slackApp,
      ...patch
    };
    await this.save(config);
  }

  async updateGlobal(patch: Partial<AppConfig["global"]>): Promise<void> {
    const config = await this.load();
    config.global = {
      ...config.global,
      ...patch
    };
    await this.save(config);
  }

  async updateServiceState(patch: Partial<AppConfig["serviceState"]>): Promise<void> {
    const config = await this.load();
    config.serviceState = {
      ...config.serviceState,
      ...patch
    };
    await this.save(config);
  }

  resolvedPath(): string {
    return resolve(this.filePath);
  }
}

function normalizeConfig(config: AppConfig | undefined): AppConfig {
  const merged: AppConfig = {
    ...DEFAULT_CONFIG,
    ...config,
    repositories: (config?.repositories ?? []).map((repo) => normalizeRepository(repo)),
    global: {
      ...DEFAULT_CONFIG.global,
      ...config?.global
    },
    slackApp: {
      ...DEFAULT_CONFIG.slackApp,
      ...config?.slackApp
    },
    serviceState: {
      ...DEFAULT_CONFIG.serviceState,
      ...config?.serviceState
    }
  };

  const workspaceDir = resolve(merged.global.workspaceDir || ".");
  merged.global.workspaceDir = workspaceDir;
  merged.repositories = merged.repositories.map((repo) => {
    const sourcePath = String(repo.localPath || "").trim() || repo.id;
    const localPath = isAbsolute(sourcePath) ? sourcePath : resolve(workspaceDir, sourcePath);
    return {
      ...repo,
      localPath
    };
  });

  return merged;
}

function normalizeRepository(repo: RepositoryConfig): RepositoryConfig {
  return {
    ...repo,
    triageCommand: normalizeTriageCommand(repo.triageCommand),
    implementCommand: normalizeImplementCommand(repo.implementCommand),
    triageWording: String(repo.triageWording || DEFAULT_TRIAGE_WORDING),
    implementWording: String(repo.implementWording || DEFAULT_IMPLEMENT_WORDING),
    ignoreWording: String(repo.ignoreWording || DEFAULT_IGNORE_WORDING),
    enabled: Boolean(repo.enabled),
    perRepoConcurrency: Math.max(1, Number(repo.perRepoConcurrency || 1)),
    slack: {
      enabled: Boolean(repo.slack?.enabled),
      channelId: String(repo.slack?.channelId ?? ""),
      transport: repo.slack?.transport ?? "none"
    }
  };
}

function normalizeTriageCommand(command: string): string {
  const value = String(command || "").trim();
  if (!value || isLegacyCodexSubcommand(value, "triage") || isLegacyDefaultTriageCommand(value)) {
    return DEFAULT_TRIAGE_COMMAND;
  }
  return value;
}

function normalizeImplementCommand(command: string): string {
  const value = String(command || "").trim();
  if (!value || isLegacyCodexSubcommand(value, "implement") || isLegacyDefaultImplementCommand(value)) {
    return DEFAULT_IMPLEMENT_COMMAND;
  }
  return value;
}

function isLegacyCodexSubcommand(command: string, subcommand: "triage" | "implement"): boolean {
  return new RegExp(`^codex\\s+${subcommand}(\\s|$)`, "i").test(command.trim());
}

function isLegacyDefaultTriageCommand(command: string): boolean {
  const value = command.trim();
  if (value.includes("Return Markdown with sections: ## Decision, ## Reason, ## Analysis, ## Evidence.")) {
    return true;
  }
  if (value.includes("Return ONLY a JSON object with fields: needs_processing (boolean), reason (string).")) {
    return true;
  }
  return (
    value.startsWith("codex exec") &&
    value.includes("Decide whether engineering implementation is needed now.") &&
    (!value.includes("Do NOT post/edit issue comments.") ||
      !value.includes("You MUST inspect relevant code files and tests in the current repository before deciding."))
  );
}

function isLegacyDefaultImplementCommand(command: string): boolean {
  const value = command.trim();
  if (value.includes("Read the issue context JSON file at {context_file}. Implement the fix in the current repository and create/update a PR when needed.")) {
    return true;
  }
  return (
    value.startsWith("codex exec") &&
    value.includes("Implement the fix in the current repository") &&
    (!value.includes("Do NOT post/edit issue comments.") ||
      !value.includes("Any code changes MUST be made in a newly created git worktree"))
  );
}
