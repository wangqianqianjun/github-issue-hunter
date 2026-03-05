export type SlackTransport = "none" | "slack_sdk" | "chat_sdk";
export type PrIssueReferenceMode = "close_keywords" | "refs";
export type AgentBackend = "codex" | "claude";

export interface RepositorySlackConfig {
  enabled: boolean;
  channelId: string;
  transport: SlackTransport;
}

export interface RepositoryConfig {
  id: string;
  owner: string;
  repo: string;
  localPath: string;
  mediaRepo?: string;
  mediaBranch?: string;
  triageCommand: string;
  implementCommand: string;
  triageWording: string;
  implementWording: string;
  ignoreWording: string;
  prIssueReferenceMode?: PrIssueReferenceMode;
  enabled: boolean;
  perRepoConcurrency: number;
  slack: RepositorySlackConfig;
}

export interface GlobalConfig {
  pollIntervalSeconds: number;
  globalConcurrency: number;
  workspaceDir: string;
  closeIssueOnDone: boolean;
  keepWorktrees: boolean;
  planMode: boolean;
  agentBackend: AgentBackend;
}

export interface SlackAppConfig {
  enabled: boolean;
  botToken: string;
  appToken: string;
  signingSecret: string;
  clientId: string;
  clientSecret: string;
  botTokenEnv: string;
  signingSecretEnv: string;
  appTokenEnv: string;
  clientIdEnv: string;
  clientSecretEnv: string;
  webhookBaseUrl: string;
  appDisplayName: string;
  botDisplayName: string;
  useSocketMode: boolean;
}

export interface ServiceState {
  running: boolean;
  lastRunAt: string;
  lastError: string;
  activeTasks: number;
  lastHealthAt?: string;
}

export interface AppConfig {
  repositories: RepositoryConfig[];
  global: GlobalConfig;
  slackApp: SlackAppConfig;
  serviceState: ServiceState;
}

export interface IssueExecutionRecord {
  issueKey: string;
  repoId: string;
  issueNumber: number;
  state:
    | "new"
    | "triaging"
    | "ignored"
    | "awaiting_approval"
    | "scheduled"
    | "implementing"
    | "completed"
    | "failed";
  summary: string;
  prUrl: string;
  rootCause: string;
  solution: string;
  closedAt: string;
  threadTs: string;
  lastExternalCommentId?: number;
  lastExternalCommentAt?: string;
  lastSlackSignalAt?: string;
  lastHandledSlackSignalAt?: string;
  lastSlackSignalText?: string;
  codexSessionId?: string;
  triageSessionId?: string;
  implementSessionId?: string;
  issueWorktreePath?: string;
  issueWorktreeBranch?: string;
  lastTriggerType?: "new" | "retry_failed" | "new_comment" | "slack_signal" | "approval" | "manual" | "stale_recovery";
  failureCategory?: "transient" | "logic" | "config" | "cancelled" | "unknown";
  failureRetryEligible?: boolean;
  lastWorkerHeartbeatAt?: string;
  updatedAt: string;
}
