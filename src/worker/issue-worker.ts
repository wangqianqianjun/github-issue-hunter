import { dirname, join, resolve } from "node:path";

import { ConfigStore } from "../core/config-store.js";
import { IssueEngine } from "../core/issue-engine.js";
import { FileRuntimeStore } from "../core/runtime-store.js";
import { GhCliClient } from "../clients/gh-cli-client.js";
import { resolveAgentBinary } from "../clients/agent-detect.js";
import { CodexRunner } from "../core/codex-runner.js";
import { ChatSlackBridge } from "../chat/vercel-chat-bridge.js";
import {
  createNotifierFactory,
  prepareWorkspaceWithConfig,
  writeRegressionCaseWithRuntime
} from "../core/issue-hunter-service.js";

interface WorkerArgs {
  configPath: string;
  repoId: string;
  issueNumber: number;
  issueKey: string;
  triggerType: "new" | "retry_failed" | "new_comment" | "slack_signal" | "approval" | "manual" | "stale_recovery";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const heartbeatIntervalMs =
    Math.max(10, Number(process.env.ISSUE_HUNTER_WORKER_HEARTBEAT_INTERVAL_SECONDS || 30)) * 1000;

  const configStore = new ConfigStore(args.configPath);
  const initialConfig = await configStore.load();
  const agentBackend = initialConfig.global.agentBackend;
  const agentBinary = resolveAgentBinary(agentBackend);
  const stateRoot = resolve(dirname(args.configPath), "runtime");
  const runtimeStore = new FileRuntimeStore(join(stateRoot, "issues.json"));
  const regressionDir = join(stateRoot, "regression_cases");

  const chatBridge = new ChatSlackBridge(
    configStore,
    async () => ({
      running: true,
      activeTasks: 1,
      queueLength: 0,
      lastRunAt: "",
      lastError: ""
    }),
    async () => ({
      stopped: false,
      issueKey: args.issueKey,
      message: "Worker does not accept stop commands through this bridge"
    })
  );

  const engine = new IssueEngine({
    getConfig: async () => configStore.load(),
    runtimeStore,
    githubFactory: (repo) =>
      new GhCliClient({
        owner: repo.owner,
        repo: repo.repo,
        localPath: repo.localPath,
        mediaRepo: repo.mediaRepo,
        mediaBranch: repo.mediaBranch
      }),
    codexFactory: (repo) =>
      new CodexRunner({
        triageCommand: repo.triageCommand,
        implementCommand: repo.implementCommand,
        defaultWorkingDirectory: repo.localPath,
        agentBinary
      }),
    notifierFactory: createNotifierFactory(configStore, chatBridge),
    prepareWorkspace: async (repo, issue, comments, imageUrls, existingRecord) =>
      prepareWorkspaceWithConfig(configStore, repo, issue, comments, imageUrls, existingRecord),
    onThreadRegistered: async (issueKey, threadToken) => {
      process.send?.({
        type: "thread_registered",
        issueKey,
        threadToken
      });
    },
    onThreadUnregistered: async (issueKey) => {
      process.send?.({
        type: "thread_unregistered",
        issueKey
      });
    },
    writeBoard: async () => undefined,
    writeRegressionCase: async (repo, issueNumber, issueTitle, result) =>
      writeRegressionCaseWithRuntime(regressionDir, repo, issueNumber, issueTitle, result)
  });

  const requestStop = () => {
    engine.stopByIssueKey(args.issueKey);
  };

  const sendHeartbeat = () => {
    process.send?.({
      type: "heartbeat",
      issueKey: args.issueKey,
      at: new Date().toISOString()
    });
  };
  sendHeartbeat();
  const heartbeatTimer = setInterval(sendHeartbeat, heartbeatIntervalMs);
  heartbeatTimer.unref();

  process.on("message", (message: unknown) => {
    const payload = (message ?? {}) as Record<string, unknown>;
    if (payload.type !== "stop") {
      return;
    }

    const stoppedByIssue = engine.stopByIssueKey(args.issueKey);
    const stoppedByThread = !stoppedByIssue && payload.threadToken
      ? engine.stopByThread(String(payload.threadToken)).stopped
      : false;

    process.send?.({
      type: "stop_ack",
      issueKey: args.issueKey,
      stopped: stoppedByIssue || stoppedByThread
    });
  });

  // Keep worker alive even if parent scheduler process exits.
  process.on("disconnect", () => {
    // Intentionally no-op.
  });

  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);

  try {
    await engine.runSpecificIssue(args.repoId, args.issueNumber, args.triggerType);
    process.send?.({ type: "completed", issueKey: args.issueKey });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

function parseArgs(argv: string[]): WorkerArgs {
  const args = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key?.startsWith("--")) {
      continue;
    }
    if (typeof value !== "string") {
      continue;
    }
    args.set(key.slice(2), value);
  }

  const configPath = String(args.get("config") || "").trim();
  const repoId = String(args.get("repo-id") || "").trim();
  const issueNumberRaw = Number(args.get("issue-number"));
  const issueKey = String(args.get("issue-key") || "").trim();
  const triggerTypeRaw = String(args.get("trigger-type") || "").trim();

  if (!configPath || !repoId || !Number.isFinite(issueNumberRaw) || issueNumberRaw <= 0) {
    throw new Error(
      "Invalid worker args. Required: --config <path> --repo-id <id> --issue-number <number> [--issue-key <key>]"
    );
  }

  return {
    configPath,
    repoId,
    issueNumber: issueNumberRaw,
    issueKey: issueKey || `${repoId}#${issueNumberRaw}`,
    triggerType: isValidTriggerType(triggerTypeRaw) ? triggerTypeRaw : "manual"
  };
}

function isValidTriggerType(value: string): value is WorkerArgs["triggerType"] {
  return ["new", "retry_failed", "new_comment", "slack_signal", "approval", "manual", "stale_recovery"].includes(value);
}

void main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.send?.({
      type: "failed",
      message
    });
    process.exit(1);
  });
