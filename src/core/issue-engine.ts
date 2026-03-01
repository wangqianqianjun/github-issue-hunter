import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import { TaskCoordinator } from "./task-coordinator.js";
import type { AppConfig, IssueExecutionRecord, RepositoryConfig } from "../types/config.js";
import { runCommand, type CommandResult } from "../utils/run-command.js";

export interface RuntimeStore {
  isSeen(issueKey: string): Promise<boolean>;
  getRecord(issueKey: string): Promise<IssueExecutionRecord | null>;
  markSeen(issueKey: string): Promise<void>;
  saveRecord(record: IssueExecutionRecord): Promise<void>;
  listCompleted(): Promise<IssueExecutionRecord[]>;
}

export interface GitHubClientLike {
  listOpenIssues(): Promise<Record<string, unknown>[]>;
  getIssue(issueNumber: number): Promise<Record<string, unknown>>;
  listIssueComments(issueNumber: number): Promise<Record<string, unknown>[]>;
  createIssueComment(issueNumber: number, body: string): Promise<void>;
  closeIssue(issueNumber: number): Promise<void>;
  downloadImages?(urls: string[], outputDir: string): Promise<string[]>;
}

export interface CodexRunnerLike {
  runTriage(
    contextFile: string,
    issueNumber: number,
    issueTitle: string,
    workingDirectory?: string,
    onProgress?: (update: string) => Promise<void> | void,
    abortSignal?: AbortSignal,
    resumeSessionId?: string
  ): Promise<Record<string, unknown>>;
  runImplementation(
    contextFile: string,
    issueNumber: number,
    issueTitle: string,
    originalUserMessage: string,
    workingDirectory?: string,
    onProgress?: (update: string) => Promise<void> | void,
    abortSignal?: AbortSignal,
    resumeSessionId?: string
  ): Promise<Record<string, unknown>>;
}

export interface IssueNotifier {
  postIssueStart(issue: Record<string, unknown>): Promise<string>;
  postThreadUpdate(threadTs: string, text: string): Promise<void>;
}

export interface WorkspacePreparation {
  contextFile: string;
  worktreePath?: string;
  worktreeBranch?: string;
  worktreeCreated?: boolean;
  cleanup: () => Promise<void>;
}

type CommandRunner = (
  command: string,
  args: string[],
  options?: { cwd?: string; input?: string }
) => Promise<CommandResult>;

interface IssueEngineDependencies {
  getConfig: () => Promise<AppConfig>;
  runtimeStore: RuntimeStore;
  githubFactory: (repo: RepositoryConfig) => GitHubClientLike;
  codexFactory: (repo: RepositoryConfig) => CodexRunnerLike;
  notifierFactory: (repo: RepositoryConfig) => IssueNotifier | null;
  onRepositoryScanError?: (input: {
    repo: RepositoryConfig;
    error: string;
    category: IssueFailureCategory;
    retryEligible: boolean;
  }) => Promise<void> | void;
  externalTaskExecutor?: (task: {
    repo: RepositoryConfig;
    issueNumber: number;
    issueKey: string;
    triggerType: IssueTaskInput["triggerType"];
  }) => Promise<void>;
  prepareWorkspace?: (
    repo: RepositoryConfig,
    issue: Record<string, unknown>,
    comments: Record<string, unknown>[],
    imageUrls: string[]
  ) => Promise<WorkspacePreparation>;
  onThreadRegistered?: (issueKey: string, threadToken: string, repo: RepositoryConfig) => Promise<void> | void;
  onThreadUnregistered?: (issueKey: string) => Promise<void> | void;
  writeBoard: (records: IssueExecutionRecord[]) => Promise<void>;
  writeRegressionCase: (
    repo: RepositoryConfig,
    issueNumber: number,
    issueTitle: string,
    result: Record<string, unknown>
  ) => Promise<void>;
  commandRunner?: CommandRunner;
}

interface IssueTaskInput {
  repo: RepositoryConfig;
  config: AppConfig;
  github: GitHubClientLike;
  codex: CodexRunnerLike;
  notifier: IssueNotifier | null;
  issueNumber: number;
  issueKey: string;
  existingRecord: IssueExecutionRecord | null;
  triggerType: "new" | "retry_failed" | "new_comment" | "slack_signal" | "approval" | "manual" | "stale_recovery";
}

type IssueTriggerType = IssueTaskInput["triggerType"];

export class IssueEngine {
  private readonly coordinator = new TaskCoordinator();
  private readonly runningAbortControllers = new Map<string, AbortController>();
  private readonly threadToIssueKey = new Map<string, string>();
  private readonly issueKeyToThreadTokens = new Map<string, Set<string>>();
  private readonly commandRunner: CommandRunner;

  constructor(private readonly deps: IssueEngineDependencies) {
    this.commandRunner = deps.commandRunner ?? runCommand;
  }

  activeTasks(): number {
    return this.coordinator.activeCount();
  }

  stopByThread(threadToken: string): { stopped: boolean; issueKey: string; message: string } {
    const aliases = deriveThreadTokenAliases(threadToken);
    for (const token of aliases) {
      const issueKey = this.threadToIssueKey.get(token);
      if (!issueKey) {
        continue;
      }
      const controller = this.runningAbortControllers.get(issueKey);
      if (!controller) {
        return {
          stopped: false,
          issueKey,
          message: `Issue ${issueKey} 当前没有可停止的运行中的 Codex 任务。`
        };
      }
      controller.abort();
      return {
        stopped: true,
        issueKey,
        message: `已停止 issue ${issueKey} 的 Codex 任务。`
      };
    }

    return {
      stopped: false,
      issueKey: "",
      message: "当前 thread 没有关联运行中的 issue 任务。"
    };
  }

  stopByIssueKey(issueKey: string): boolean {
    const key = String(issueKey || "").trim();
    if (!key) {
      return false;
    }
    const controller = this.runningAbortControllers.get(key);
    if (!controller) {
      return false;
    }
    controller.abort();
    return true;
  }

  async runOnce(): Promise<void> {
    const config = await this.deps.getConfig();
    const pendingTasks = await this.collectPendingTasks(config);
    if (!pendingTasks.length) {
      return;
    }

    const globalLimiter = createLimiter(Math.max(1, Number(config.global.globalConcurrency || 1)));
    const repoLimiters = new Map<string, ReturnType<typeof createLimiter>>();

    await Promise.all(
      pendingTasks.map(async (task) => {
        let repoLimiter = repoLimiters.get(task.repo.id);
        if (!repoLimiter) {
          repoLimiter = createLimiter(Math.max(1, Number(task.repo.perRepoConcurrency || 1)));
          repoLimiters.set(task.repo.id, repoLimiter);
        }

        await globalLimiter(async () => {
          await repoLimiter!(async () => {
            try {
              if (this.deps.externalTaskExecutor) {
                await this.deps.externalTaskExecutor({
                  repo: task.repo,
                  issueNumber: task.issueNumber,
                  issueKey: task.issueKey,
                  triggerType: task.triggerType
                });
              } else {
                await this.processIssue(task);
              }
            } finally {
              this.coordinator.release(task.issueKey);
            }
          });
        });
      })
    );
  }

  async runSpecificIssue(repoId: string, issueNumber: number, triggerType: IssueTriggerType = "manual"): Promise<void> {
    const config = await this.deps.getConfig();
    const repo = config.repositories.find((item) => item.id === repoId && item.enabled);
    if (!repo) {
      throw new Error(`Repository ${repoId} not found or disabled`);
    }

    const issueKey = `${repo.owner}/${repo.repo}#${issueNumber}`;
    if (!this.coordinator.tryAcquire(issueKey)) {
      throw new Error(`Issue ${issueKey} is already running`);
    }

    try {
      await this.deps.runtimeStore.markSeen(issueKey);
      const existingRecord = await this.deps.runtimeStore.getRecord(issueKey);
      const github = this.deps.githubFactory(repo);
      const codex = this.deps.codexFactory(repo);
      const notifier = this.deps.notifierFactory(repo);
      await this.processIssue({
        repo,
        config,
        github,
        codex,
        notifier,
        issueNumber,
        issueKey,
        existingRecord,
        triggerType
      });
    } finally {
      this.coordinator.release(issueKey);
    }
  }

  private async collectPendingTasks(config: AppConfig): Promise<IssueTaskInput[]> {
    const tasks: IssueTaskInput[] = [];

    for (const repo of config.repositories) {
      if (!repo.enabled) {
        continue;
      }

      const github = this.deps.githubFactory(repo);
      const codex = this.deps.codexFactory(repo);
      const notifier = this.deps.notifierFactory(repo);

      let issues: Record<string, unknown>[] = [];
      try {
        issues = await github.listOpenIssues();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const failure = classifyIssueFailure(detail);
        await this.deps.onRepositoryScanError?.({
          repo,
          error: detail,
          category: failure.category,
          retryEligible: failure.retryEligible
        });
        // eslint-disable-next-line no-console
        console.warn(
          `[issue-hunter] listOpenIssues failed for ${repo.owner}/${repo.repo}: ${detail}. Continue with other repositories.`
        );
        continue;
      }
      for (const issueSummary of issues) {
        if ((issueSummary as { pull_request?: unknown }).pull_request) {
          continue;
        }

        const issueNumber = Number(issueSummary.number);
        if (!Number.isFinite(issueNumber)) {
          continue;
        }

        const issueKey = `${repo.owner}/${repo.repo}#${issueNumber}`;
        const seen = await this.deps.runtimeStore.isSeen(issueKey);
        const existingRecord = await this.deps.runtimeStore.getRecord(issueKey);
        const seenWithoutRecord = seen && !existingRecord;

        const retryFailed = seen && shouldRetryFailedRecord(existingRecord);
        const retryStaleInFlight = seen && shouldRecoverStaleInFlightRecord(existingRecord);
        const retrySlackSignal =
          seen &&
          hasPendingSlackSignal(existingRecord) &&
          !retryStaleInFlight &&
          existingRecord?.state !== "triaging" &&
          existingRecord?.state !== "scheduled" &&
          existingRecord?.state !== "implementing";

        let retryNewComment = false;
        let latestComments: Record<string, unknown>[] | null = null;
        if (
          seen &&
          !retryFailed &&
          !retryStaleInFlight &&
          !retrySlackSignal &&
          existingRecord &&
          (existingRecord.state === "completed" ||
            existingRecord.state === "ignored" ||
            existingRecord.state === "failed")
        ) {
          latestComments = latestComments ?? (await github.listIssueComments(issueNumber));
          const latestExternal = findLatestExternalComment(latestComments);
          const baseline = Number(existingRecord.lastExternalCommentId || 0);
          retryNewComment = latestExternal.id > baseline;
        }

        if (
          seen &&
          !retryFailed &&
          !retryStaleInFlight &&
          !retrySlackSignal &&
          existingRecord?.state === "awaiting_approval"
        ) {
          latestComments = latestComments ?? (await github.listIssueComments(issueNumber));
          const baseline = Number(existingRecord.lastExternalCommentId || 0);
          const latestExternal = findLatestExternalComment(latestComments);
          retryNewComment = latestExternal.id > baseline;
        }

        const shouldSchedule =
          !seen ||
          seenWithoutRecord ||
          retryFailed ||
          retryStaleInFlight ||
          retrySlackSignal ||
          retryNewComment;
        if (!shouldSchedule || !this.coordinator.tryAcquire(issueKey)) {
          continue;
        }

        if (seenWithoutRecord) {
          // eslint-disable-next-line no-console
          console.warn(
            `[issue-hunter] scheduling ${issueKey} because it is marked seen but runtime record is missing`
          );
        }
        if (retryStaleInFlight) {
          // eslint-disable-next-line no-console
          console.warn(
            `[issue-hunter] scheduling stale in-flight recovery for ${issueKey} ` +
              `(state=${existingRecord?.state || "unknown"}, updatedAt=${existingRecord?.updatedAt || "n/a"})`
          );
        }

        if (!seen) {
          await this.deps.runtimeStore.markSeen(issueKey);
        }
        tasks.push({
          repo,
          config,
          github,
          codex,
          notifier,
          issueNumber,
          issueKey,
          existingRecord,
          triggerType: (!seen || seenWithoutRecord)
            ? "new"
            : retryFailed
              ? "retry_failed"
              : retryStaleInFlight
                ? "stale_recovery"
              : retrySlackSignal
                ? "slack_signal"
                : "new_comment"
        });
      }
    }

    return tasks;
  }

  private async processIssue(input: IssueTaskInput): Promise<void> {
    const issue = await input.github.getIssue(input.issueNumber);
    const issueTitle = String(issue.title ?? `issue-${input.issueNumber}`);
    let threadTs = String(input.existingRecord?.threadTs ?? "").trim();
    const abortController = new AbortController();
    this.runningAbortControllers.set(input.issueKey, abortController);

    const issueComments = await input.github.listIssueComments(input.issueNumber);
    const latestExternalComment = findLatestExternalComment(issueComments);
    const latestExternalCommentBody = findLatestExternalCommentBody(issueComments);
    const inheritedSlackSignalAt = String(input.existingRecord?.lastSlackSignalAt ?? "").trim();
    const inheritedSlackSignalText = String(input.existingRecord?.lastSlackSignalText ?? "").trim();
    const inheritedHandledSlackSignalAt = String(input.existingRecord?.lastHandledSlackSignalAt ?? "").trim();
    let currentCodexSessionId = String(
      input.existingRecord?.codexSessionId ??
      input.existingRecord?.implementSessionId ??
      input.existingRecord?.triageSessionId ??
      ""
    ).trim();
    const handledSlackSignalAt =
      input.triggerType === "slack_signal" ? inheritedSlackSignalAt : inheritedHandledSlackSignalAt;
    const cycleId = buildIssueCycleId({
      issueKey: input.issueKey,
      triggerType: input.triggerType,
      latestExternalCommentId: latestExternalComment.id,
      latestExternalCommentAt: latestExternalComment.createdAt,
      lastSlackSignalAt: inheritedSlackSignalAt
    });

    const contextComments = withSyntheticSignalComments(issueComments, input.triggerType, inheritedSlackSignalText);
    const explicitApprovalSignal =
      input.triggerType === "new_comment" &&
      input.existingRecord?.state === "awaiting_approval" &&
      isExplicitApprovalComment(latestExternalCommentBody);
    let implementUserMessage = buildImplementUserMessage(
      issue,
      issueComments,
      input.triggerType,
      inheritedSlackSignalText,
      input.existingRecord
    );
    if (explicitApprovalSignal) {
      implementUserMessage = buildImplementUserMessageFromApproval(
        issue,
        latestExternalCommentBody,
        input.existingRecord
      );
    }

    const baseRecord = (state: IssueExecutionRecord["state"], patch: Partial<IssueExecutionRecord>): IssueExecutionRecord => ({
      issueKey: input.issueKey,
      repoId: input.repo.id,
      issueNumber: input.issueNumber,
      state,
      summary: patch.summary ?? "",
      prUrl: patch.prUrl ?? "",
      rootCause: patch.rootCause ?? "",
      solution: patch.solution ?? "",
      closedAt: patch.closedAt ?? "",
      threadTs: patch.threadTs ?? threadTs,
      lastExternalCommentId: patch.lastExternalCommentId ?? latestExternalComment.id,
      lastExternalCommentAt: patch.lastExternalCommentAt ?? latestExternalComment.createdAt,
      lastSlackSignalAt: patch.lastSlackSignalAt ?? inheritedSlackSignalAt,
      lastHandledSlackSignalAt: patch.lastHandledSlackSignalAt ?? handledSlackSignalAt,
      lastSlackSignalText: patch.lastSlackSignalText ?? inheritedSlackSignalText,
      codexSessionId: patch.codexSessionId ?? currentCodexSessionId,
      triageSessionId: patch.triageSessionId ?? currentCodexSessionId,
      implementSessionId: patch.implementSessionId ?? currentCodexSessionId,
      lastTriggerType: patch.lastTriggerType ?? input.triggerType,
      failureCategory: patch.failureCategory ?? undefined,
      failureRetryEligible: patch.failureRetryEligible ?? undefined,
      lastWorkerHeartbeatAt:
        patch.lastWorkerHeartbeatAt ??
        input.existingRecord?.lastWorkerHeartbeatAt ??
        nowIso(),
      updatedAt: nowIso()
    });
    const threadBatchIntervalMs =
      Math.max(5, Number(process.env.ISSUE_HUNTER_SLACK_BATCH_INTERVAL_SECONDS || 45)) * 1000;
    const threadBatcher = createThreadUpdateBatcher(input.notifier, threadTs, threadBatchIntervalMs);

    try {
      const shouldPostTriageWording =
        input.triggerType === "new" ||
        input.triggerType === "retry_failed" ||
        input.triggerType === "stale_recovery";
      if (shouldPostTriageWording) {
        await this.createIssueCommentIfNeeded(
          input.github,
          input.issueNumber,
          input.repo.triageWording,
          issueComments,
          `${cycleId}:triage`
        );
      }
      await this.deps.runtimeStore.saveRecord(baseRecord("triaging", {}));

      const imageUrls = extractImageUrls(issue, issueComments);
      const workspace = await this.prepareWorkspace(
        input.repo,
        issue,
        contextComments,
        imageUrls,
        input.github
      );

      try {
        const progressIntervalMs = Math.max(5, Number(process.env.CODEX_PROGRESS_UPDATE_INTERVAL_SECONDS || 20)) * 1000;

        if (input.notifier) {
          if (!threadTs) {
            threadTs = await input.notifier.postIssueStart(issue);
          }
          threadBatcher.setThread(threadTs);
          this.registerThreadToken(input.issueKey, threadTs);
          await this.deps.onThreadRegistered?.(input.issueKey, threadTs, input.repo);
          const startMessage =
            input.triggerType === "new"
              ? "Issue 已进入评估阶段，AI 将判断下一阶段。"
              : input.triggerType === "retry_failed"
                ? "检测到上次执行失败，开始恢复并由 AI 判断下一阶段。"
              : input.triggerType === "stale_recovery"
                ? "检测到任务状态长期停留在处理中，开始自动恢复并由 AI 判断下一阶段。"
                : `收到新反馈（${triggerTypeLabel(input.triggerType)}），已转交同一 AI 会话判断下一阶段。`;
          await threadBatcher.push(startMessage, { immediate: true });
        }

        let triageReason = String(input.existingRecord?.summary ?? "").trim();
        let needsProcessing = true;
        let triageNextStep: "implement" | "plan" | "confirm" | "ignore" = "implement";

        if (explicitApprovalSignal) {
          needsProcessing = true;
          triageNextStep = "implement";
          if (!triageReason) {
            triageReason = "检测到用户已明确批准，直接进入实现阶段。";
          }
          if (input.notifier && threadTs) {
            await threadBatcher.push("检测到用户明确批准，跳过重新评估，直接进入实现阶段。");
          }
        } else {
          const triageRelay = createCodexProgressRelay(
            async (message) => {
              await threadBatcher.push(message);
            },
            progressIntervalMs
          );
          let triage: Record<string, unknown>;
          try {
            triage = await input.codex.runTriage(
              workspace.contextFile,
              input.issueNumber,
              issueTitle,
              workspace.worktreePath,
              async (update) => {
                await triageRelay.push(update);
              },
              abortController.signal,
              currentCodexSessionId
            );
          } finally {
            await triageRelay.stop();
          }

          needsProcessing = resolveTriageNeedsProcessing(triage);
          triageReason = String(triage.reason ?? "").trim();
          triageNextStep = resolveTriageNextStep(triage, input.config.global.planMode, needsProcessing);
          const triageSessionId = String(triage.codex_session_id ?? triage.thread_id ?? "").trim();
          if (triageSessionId) {
            currentCodexSessionId = triageSessionId;
          }

          if (input.notifier && threadTs) {
            await threadBatcher.push(buildTriageThreadMessage(triage));
            await threadBatcher.push(
              triageNextStep === "ignore" || !needsProcessing
                ? "决定：当前不进入开发处理。"
                : triageNextStep === "confirm"
                  ? "决定：等待用户确认后再进入实现。"
                  : triageNextStep === "plan"
                    ? "决定：先输出方案并等待确认。"
                    : "决定：进入开发处理。"
            );
          }
        }

        if (!needsProcessing || triageNextStep === "ignore") {
          await this.createIssueCommentIfNeeded(
            input.github,
            input.issueNumber,
            buildIgnoreComment(input.repo.ignoreWording, triageReason),
            issueComments,
            `${cycleId}:ignored`
          );
          await this.deps.runtimeStore.saveRecord(
            baseRecord("ignored", {
              summary: triageReason,
              codexSessionId: currentCodexSessionId,
              triageSessionId: currentCodexSessionId,
              implementSessionId: currentCodexSessionId,
              failureCategory: undefined,
              failureRetryEligible: undefined,
              threadTs
            })
          );
          return;
        }

        if (triageNextStep === "confirm") {
          const existingPlan = String(input.existingRecord?.solution || "").trim();
          await this.createIssueCommentIfNeeded(
            input.github,
            input.issueNumber,
            buildConfirmProposalComment(input.repo.implementWording, triageReason, existingPlan),
            issueComments,
            `${cycleId}:confirm`
          );
          await this.deps.runtimeStore.saveRecord(
            baseRecord("awaiting_approval", {
              summary: triageReason || String(input.existingRecord?.summary || "").trim(),
              rootCause: String(input.existingRecord?.rootCause || "").trim(),
              solution: existingPlan,
              codexSessionId: currentCodexSessionId,
              triageSessionId: currentCodexSessionId,
              implementSessionId: currentCodexSessionId,
              failureCategory: undefined,
              failureRetryEligible: undefined,
              threadTs
            })
          );
          if (input.notifier && threadTs) {
            await threadBatcher.push("已更新待确认状态，等待用户确认后再开始实现。");
          }
          return;
        }

        if (input.config.global.planMode && triageNextStep === "plan") {
          if (input.notifier && threadTs) {
            await threadBatcher.push("Plan 模式已开启，先生成详细方案并等待审批。");
          }

          const planningRelay = createCodexProgressRelay(
            async (message) => {
              await threadBatcher.push(message);
            },
            progressIntervalMs
          );
          let planningResult: Record<string, unknown>;
          try {
            planningResult = await input.codex.runImplementation(
              workspace.contextFile,
              input.issueNumber,
              issueTitle,
              buildPlanOnlyUserMessage(implementUserMessage, triageReason),
              workspace.worktreePath,
              async (update) => {
                await planningRelay.push(update);
              },
              abortController.signal,
              currentCodexSessionId
            );
          } finally {
            await planningRelay.stop();
          }

          const planningSessionId = String(
            planningResult.codex_session_id ?? planningResult.thread_id ?? ""
          ).trim();
          if (planningSessionId) {
            currentCodexSessionId = planningSessionId;
          }

          const planning = normalizeImplementationResult(planningResult);
          const planSnapshot = buildPlanSnapshot(planning);
          await this.createIssueCommentIfNeeded(
            input.github,
            input.issueNumber,
            buildPlanProposalComment(input.repo.implementWording, triageReason, planning),
            issueComments,
            `${cycleId}:plan`
          );
          await this.deps.runtimeStore.saveRecord(
            baseRecord("awaiting_approval", {
              summary: triageReason || planning.summary || "已提交设计与实现方案，等待审批。",
              rootCause: planning.rootCause,
              solution: planSnapshot,
              codexSessionId: currentCodexSessionId,
              triageSessionId: currentCodexSessionId,
              implementSessionId: currentCodexSessionId,
              failureCategory: undefined,
              failureRetryEligible: undefined,
              threadTs
            })
          );

          if (input.notifier && threadTs) {
            await threadBatcher.push("方案已写回 issue，等待用户 approve 后再开始实际实现。");
          }
          return;
        }

        await this.createIssueCommentIfNeeded(
          input.github,
          input.issueNumber,
          input.repo.implementWording,
          issueComments,
          `${cycleId}:implement`
        );
        await this.deps.runtimeStore.saveRecord(
          baseRecord("scheduled", {
            summary: "",
            rootCause: "",
            solution: "",
            threadTs,
            codexSessionId: currentCodexSessionId,
            triageSessionId: currentCodexSessionId,
            implementSessionId: currentCodexSessionId,
            failureCategory: undefined,
            failureRetryEligible: undefined
          })
        );

        if (input.notifier && threadTs) {
          await threadBatcher.push("Issue 已进入处理队列，开始执行修复。");
        }

        await this.deps.runtimeStore.saveRecord(
          baseRecord("implementing", {
            summary: "",
            rootCause: "",
            solution: "",
            threadTs
          })
        );

        const progressRelay = createCodexProgressRelay(
          async (message) => {
            await threadBatcher.push(message);
          },
          progressIntervalMs
        );

        let implement: Record<string, unknown>;
        try {
          implement = await input.codex.runImplementation(
            workspace.contextFile,
            input.issueNumber,
            issueTitle,
            implementUserMessage,
            workspace.worktreePath,
            async (update) => {
              await progressRelay.push(update);
            },
            abortController.signal,
            currentCodexSessionId
          );
        } finally {
          await progressRelay.stop();
        }

        const normalized = normalizeImplementationResult(implement);
        normalized.prUrl = await this.ensurePullRequestUrl({
          repo: input.repo,
          issueNumber: input.issueNumber,
          issueTitle,
          triageReason,
          workspace,
          currentPrUrl: normalized.prUrl
        });
        const implementSessionId = String(implement.codex_session_id ?? implement.thread_id ?? "").trim();
        if (implementSessionId) {
          currentCodexSessionId = implementSessionId;
        }
        let completionComments = issueComments;
        try {
          completionComments = await input.github.listIssueComments(input.issueNumber);
        } catch {
          // Fallback to cached comments when listing comments fails.
        }
        await this.createIssueCommentIfNeeded(
          input.github,
          input.issueNumber,
          buildCompletionComment(normalized, triageReason),
          completionComments,
          `${cycleId}:completed`
        );

        if (input.config.global.closeIssueOnDone) {
          await input.github.closeIssue(input.issueNumber);
        }

        const completedRecord = baseRecord("completed", {
          summary: normalized.summary,
          rootCause: normalized.rootCause,
          solution: normalized.solution,
          prUrl: normalized.prUrl,
          codexSessionId: currentCodexSessionId,
          triageSessionId: currentCodexSessionId,
          implementSessionId: currentCodexSessionId,
          failureCategory: undefined,
          failureRetryEligible: undefined,
          closedAt: nowIso(),
          threadTs
        });

        await this.deps.runtimeStore.saveRecord(completedRecord);
        await this.deps.writeRegressionCase(input.repo, input.issueNumber, issueTitle, normalized);
        await this.deps.writeBoard(await this.deps.runtimeStore.listCompleted());

        if (input.notifier && threadTs) {
          await threadBatcher.push(`处理完成。PR: ${normalized.prUrl || "未提供"}`, { immediate: true });
        }
      } finally {
        await workspace.cleanup();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = isCancellationError(message);
      const failure = cancelled
        ? {
            category: "cancelled" as const,
            retryEligible: false
          }
        : classifyIssueFailure(message);
      await this.deps.runtimeStore.saveRecord(
        baseRecord("failed", {
          summary: cancelled ? "Cancelled by Slack thread command" : message,
          failureCategory: failure.category,
          failureRetryEligible: failure.retryEligible,
          threadTs
        })
      );
      if (input.notifier && threadTs) {
        await threadBatcher.push(
          cancelled ? "已收到停止指令，当前 Codex 任务已停止。" : `处理失败: ${message}`
        );
      }
    } finally {
      await threadBatcher.stop();
      this.runningAbortControllers.delete(input.issueKey);
      this.unregisterThreadTokens(input.issueKey);
      await this.deps.onThreadUnregistered?.(input.issueKey);
    }
  }

  private async prepareWorkspace(
    repo: RepositoryConfig,
    issue: Record<string, unknown>,
    comments: Record<string, unknown>[],
    imageUrls: string[],
    github: GitHubClientLike
  ): Promise<WorkspacePreparation> {
    if (this.deps.prepareWorkspace) {
      return this.deps.prepareWorkspace(repo, issue, comments, imageUrls);
    }

    const issueNumber = Number(issue.number);
    const issueDir = resolve(process.cwd(), "artifacts", repo.id, `issue-${issueNumber}`);
    await mkdir(issueDir, { recursive: true });

    const imagesDir = join(issueDir, "images");
    let imageFiles: string[] = [];
    if (github.downloadImages) {
      imageFiles = await github.downloadImages(imageUrls, imagesDir);
    }

    const context = {
      repository: {
        owner: repo.owner,
        repo: repo.repo,
        localPath: repo.localPath
      },
      issue,
      comments,
      imageUrls,
      imageFiles
    };

    const contextFile = join(issueDir, "context.json");
    await writeFile(contextFile, JSON.stringify(context, null, 2), "utf8");

    return {
      contextFile,
      worktreePath: repo.localPath,
      cleanup: async () => undefined
    };
  }

  private registerThreadToken(issueKey: string, token: string): void {
    const aliases = deriveThreadTokenAliases(token);
    if (!aliases.length) {
      return;
    }

    let tokens = this.issueKeyToThreadTokens.get(issueKey);
    if (!tokens) {
      tokens = new Set<string>();
      this.issueKeyToThreadTokens.set(issueKey, tokens);
    }

    for (const alias of aliases) {
      if (!alias) {
        continue;
      }
      tokens.add(alias);
      this.threadToIssueKey.set(alias, issueKey);
    }
  }

  private unregisterThreadTokens(issueKey: string): void {
    const tokens = this.issueKeyToThreadTokens.get(issueKey);
    if (!tokens) {
      return;
    }
    for (const token of tokens) {
      this.threadToIssueKey.delete(token);
    }
    this.issueKeyToThreadTokens.delete(issueKey);
  }

  private async createIssueCommentIfNeeded(
    github: GitHubClientLike,
    issueNumber: number,
    body: string,
    existingComments: Record<string, unknown>[],
    idempotencyKey?: string
  ): Promise<boolean> {
    const finalBody = appendIssueHunterMarker(body, idempotencyKey);
    const normalizedBody = normalizeIssueCommentBody(finalBody);
    if (!normalizedBody) {
      return false;
    }

    const normalizedIdempotencyKey = String(idempotencyKey || "").trim();
    if (normalizedIdempotencyKey) {
      const duplicatedByKey = existingComments.some(
        (item) => extractIssueHunterIdempotencyKey(String(item.body ?? "")) === normalizedIdempotencyKey
      );
      if (duplicatedByKey) {
        return false;
      }
    }

    const duplicated = existingComments.some(
      (item) => normalizeIssueCommentBody(String(item.body ?? "")) === normalizedBody
    );
    if (duplicated) {
      return false;
    }

    await github.createIssueComment(issueNumber, finalBody);
    existingComments.push({ body: finalBody });
    return true;
  }

  private async ensurePullRequestUrl(input: {
    repo: RepositoryConfig;
    issueNumber: number;
    issueTitle: string;
    triageReason: string;
    workspace: WorkspacePreparation;
    currentPrUrl: string;
  }): Promise<string> {
    const existing = String(input.currentPrUrl || "").trim();
    if (existing) {
      return existing;
    }

    const autoCreated = await this.tryAutoCreatePullRequest(input);
    if (autoCreated) {
      return autoCreated;
    }

    throw new Error(
      "Implementation completed but no PR URL was produced. Auto PR creation also failed. " +
        "Please check git changes/worktree and gh auth."
    );
  }

  private async tryAutoCreatePullRequest(input: {
    repo: RepositoryConfig;
    issueNumber: number;
    issueTitle: string;
    triageReason: string;
    workspace: WorkspacePreparation;
  }): Promise<string> {
    const repoName = `${input.repo.owner}/${input.repo.repo}`;
    const workingDir = String(input.workspace.worktreePath || "").trim() || input.repo.localPath;

    // Safety: only auto-create PR from isolated worktree runs.
    const worktreeCreated = Boolean(input.workspace.worktreeCreated);
    if (!worktreeCreated) {
      return "";
    }

    const branch = await this.resolveCurrentBranch(workingDir, input.workspace.worktreeBranch);
    if (!branch || branch === "HEAD") {
      return "";
    }

    const existingPrUrl = await this.findOpenPrUrl(repoName, branch, workingDir);
    if (existingPrUrl) {
      return existingPrUrl;
    }

    await this.commitPendingChangesIfAny(workingDir, input.issueNumber, input.issueTitle);
    await this.pushBranch(workingDir, branch);

    const createdOrExisting = await this.findOpenPrUrl(repoName, branch, workingDir);
    if (createdOrExisting) {
      return createdOrExisting;
    }

    const defaultBranch = await this.resolveDefaultBranch(repoName, workingDir);
    const aheadCount = await this.countAheadCommits(workingDir, defaultBranch);
    if (aheadCount <= 0) {
      return "";
    }

    const title = buildPrTitle(input.issueNumber, input.issueTitle);
    const body = buildPrBody(input.issueNumber, input.triageReason);
    const createResult = await this.exec("gh", [
      "pr",
      "create",
      "--repo",
      repoName,
      "--head",
      branch,
      "--base",
      defaultBranch,
      "--title",
      title,
      "--body",
      body
    ], workingDir);

    if (createResult.code !== 0) {
      return extractPrUrlFromText(createResult.stdout) || extractPrUrlFromText(createResult.stderr);
    }

    return extractPrUrlFromText(createResult.stdout) || extractPrUrlFromText(createResult.stderr);
  }

  private async resolveCurrentBranch(workingDir: string, preferred?: string): Promise<string> {
    const preset = String(preferred || "").trim();
    if (preset) {
      return preset;
    }

    const result = await this.exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], workingDir);
    if (result.code !== 0) {
      return "";
    }
    return String(result.stdout || "").trim();
  }

  private async findOpenPrUrl(repoName: string, branch: string, workingDir: string): Promise<string> {
    const result = await this.exec("gh", [
      "pr",
      "list",
      "--repo",
      repoName,
      "--head",
      branch,
      "--state",
      "open",
      "--json",
      "url"
    ], workingDir);

    if (result.code !== 0) {
      return "";
    }

    try {
      const parsed = JSON.parse(result.stdout) as Array<{ url?: string }>;
      const url = String(parsed?.[0]?.url || "").trim();
      return url;
    } catch {
      return extractPrUrlFromText(result.stdout);
    }
  }

  private async resolveDefaultBranch(repoName: string, workingDir: string): Promise<string> {
    const result = await this.exec(
      "gh",
      ["repo", "view", repoName, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"],
      workingDir
    );
    if (result.code !== 0) {
      return "main";
    }
    const branch = String(result.stdout || "").trim();
    return branch || "main";
  }

  private async commitPendingChangesIfAny(
    workingDir: string,
    issueNumber: number,
    issueTitle: string
  ): Promise<void> {
    const status = await this.exec("git", ["status", "--porcelain"], workingDir);
    if (status.code !== 0) {
      return;
    }
    if (!String(status.stdout || "").trim()) {
      return;
    }

    await this.exec("git", ["add", "-A"], workingDir);
    const message = buildCommitMessage(issueNumber, issueTitle);
    await this.exec("git", ["commit", "-m", message], workingDir);
  }

  private async pushBranch(workingDir: string, branch: string): Promise<void> {
    await this.exec("git", ["push", "-u", "origin", branch], workingDir);
  }

  private async countAheadCommits(workingDir: string, defaultBranch: string): Promise<number> {
    await this.exec("git", ["fetch", "origin", defaultBranch, "--quiet"], workingDir);
    const result = await this.exec("git", ["rev-list", "--count", `origin/${defaultBranch}..HEAD`], workingDir);
    if (result.code !== 0) {
      return 0;
    }
    const count = Number(String(result.stdout || "").trim());
    return Number.isFinite(count) ? count : 0;
  }

  private async exec(command: string, args: string[], cwd: string): Promise<CommandResult> {
    try {
      return await this.commandRunner(command, args, { cwd });
    } catch (error) {
      return {
        code: 1,
        stdout: "",
        stderr: String(error)
      };
    }
  }
}

function normalizeImplementationResult(payload: Record<string, unknown>): {
  summary: string;
  rootCause: string;
  solution: string;
  prUrl: string;
  testCases: unknown[];
} {
  return {
    summary: String(payload.summary ?? ""),
    rootCause: String(payload.root_cause ?? payload.rootCause ?? ""),
    solution: String(payload.solution ?? ""),
    prUrl: String(payload.pr_url ?? payload.prUrl ?? ""),
    testCases: Array.isArray(payload.test_cases) ? payload.test_cases : []
  };
}

function buildCompletionComment(result: {
  summary: string;
  rootCause: string;
  solution: string;
  prUrl: string;
}, reason: string): string {
  return [
    "Reason:",
    reason,
    "",
    "Summary:",
    result.summary,
    "",
    "RootCause:",
    result.rootCause,
    "",
    "Solution:",
    result.solution,
    "",
    "PR:",
    result.prUrl
  ].join("\n");
}

function buildIgnoreComment(ignoreWording: string, reason: string): string {
  const normalizedReason = String(reason || "").trim();
  if (!normalizedReason) {
    return ignoreWording;
  }
  return [ignoreWording, "", "原因:", normalizedReason].join("\n");
}

function buildPlanOnlyUserMessage(originalUserMessage: string, triageReason: string): string {
  return [
    "当前为 Plan 模式，只输出方案，不进入编码实现。",
    "要求：",
    "1. 必须基于当前仓库代码与 issue 上下文。",
    "2. 输出中文 Markdown，包含 `Summary`、`RootCause`、`Solution` 三个章节。",
    "3. `Solution` 必须包含详细实现步骤、测试验证方案、风险与回滚方案。",
    "4. 不要修改任何代码，不要创建 commit，不要创建或更新 PR。",
    "",
    "Triage 原因：",
    triageReason || "(未提供)",
    "",
    "用户原始诉求：",
    originalUserMessage || "(空)"
  ].join("\n");
}

function buildPlanProposalComment(
  implementWording: string,
  triageReason: string,
  plan: { summary: string; rootCause: string; solution: string }
): string {
  const summary = String(plan.summary || "").trim() || "（未提供）";
  const rootCause = String(plan.rootCause || "").trim() || "（未提供）";
  const solution = String(plan.solution || "").trim() || "（未提供）";

  return [
    implementWording,
    "",
    "### Triage 原因",
    triageReason || "（未提供）",
    "",
    "### 设计概览",
    summary,
    "",
    "### RootCause",
    rootCause,
    "",
    "### 实现方案",
    solution,
    "",
    "### 等待审批",
    "请在评论区回复 `approve` / `approved` / `同意` / `通过`，我将仅在收到审批后进入实现。"
  ].join("\n");
}

function buildConfirmProposalComment(implementWording: string, triageReason: string, existingPlan: string): string {
  return [
    implementWording,
    "",
    "### 当前判断",
    triageReason || "（未提供）",
    "",
    "### 下一步",
    "AI 判断当前应先等待用户确认，再进入实现。",
    "",
    "### 当前方案快照",
    existingPlan || "（暂无方案快照，可继续补充需求后由 AI 生成/更新方案）",
    "",
    "### 需要你确认",
    "请直接回复你希望 AI 继续执行的阶段（例如：继续出方案 / 更新方案 / 直接实现）。"
  ].join("\n");
}

function buildPlanSnapshot(plan: { summary: string; rootCause: string; solution: string }): string {
  return [
    "Summary:",
    String(plan.summary || "").trim() || "（未提供）",
    "",
    "RootCause:",
    String(plan.rootCause || "").trim() || "（未提供）",
    "",
    "Solution:",
    String(plan.solution || "").trim() || "（未提供）"
  ].join("\n");
}

function buildCommitMessage(issueNumber: number, issueTitle: string): string {
  const title = String(issueTitle || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!title) {
    return `fix(issue-${issueNumber}): apply issue hunter changes`;
  }
  return `fix(issue-${issueNumber}): ${title}`;
}

function buildPrTitle(issueNumber: number, issueTitle: string): string {
  const title = String(issueTitle || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  if (!title) {
    return `fix: issue #${issueNumber}`;
  }
  return `fix: issue #${issueNumber} ${title}`;
}

function buildPrBody(issueNumber: number, triageReason: string): string {
  const reason = String(triageReason || "").trim() || "(empty)";
  return [
    `Auto-created by github-issue-hunter for issue #${issueNumber}.`,
    "",
    `Reason: ${reason}`,
    "",
    `Refs #${issueNumber}`
  ].join("\n");
}

function extractPrUrlFromText(text: string): string {
  const match = String(text || "").match(/https?:\/\/github\.com\/[^\s)]+\/pull\/\d+/i);
  return match ? match[0] : "";
}

function buildTriageThreadMessage(result: Record<string, unknown>): string {
  const markdown = String(result.markdown ?? "").trim();
  if (markdown) {
    return ["Triage 分析:", truncateForThread(markdown, 3000)].join("\n\n");
  }

  const reason = String(result.reason ?? "").trim();
  if (reason) {
    return ["Triage 理由:", truncateForThread(reason, 3000)].join("\n\n");
  }

  return [
    "Triage 返回:",
    "```json",
    serializeForThread(result, 3000),
    "```"
  ].join("\n");
}

function serializeForThread(payload: Record<string, unknown>, maxLength: number): string {
  let text = "";
  try {
    text = JSON.stringify(payload, null, 2);
  } catch {
    text = String(payload);
  }

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 18))}... (truncated)`;
}

function extractImageUrls(issue: Record<string, unknown>, comments: Record<string, unknown>[]): string[] {
  const texts = [String(issue.body ?? "")].concat(comments.map((item) => String(item.body ?? "")));
  const markdown = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  const html = /<img[^>]*src=["']([^"']+)["'][^>]*>/gi;

  const unique = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(markdown)) {
      unique.add(match[1]);
    }
    for (const match of text.matchAll(html)) {
      unique.add(match[1]);
    }
  }
  return [...unique];
}

function nowIso(): string {
  return new Date().toISOString();
}

function createThreadUpdateBatcher(
  notifier: IssueNotifier | null,
  initialThreadTs: string,
  intervalMs: number
): {
  setThread: (threadToken: string) => void;
  push: (text: string, options?: { immediate?: boolean }) => Promise<void>;
  stop: () => Promise<void>;
} {
  if (!notifier) {
    return {
      setThread: () => undefined,
      push: async () => undefined,
      stop: async () => undefined
    };
  }

  let threadTs = String(initialThreadTs || "").trim();
  let pending: string[] = [];
  let sending = false;
  let stopped = false;
  let lastSentAt = 0;
  let lastSentText = "";
  const maxChars = Math.max(500, Number(process.env.ISSUE_HUNTER_SLACK_BATCH_MAX_CHARS || 2800));
  const separator = "\n\n──────────\n\n";

  const sendPending = async (force: boolean): Promise<void> => {
    if (!threadTs || sending || stopped || pending.length === 0) {
      return;
    }

    const now = Date.now();
    if (!force && lastSentAt > 0 && now - lastSentAt < intervalMs) {
      return;
    }

    const text = pending.join(separator);
    if (!force && text === lastSentText) {
      return;
    }

    pending = [];
    sending = true;
    try {
      await notifier.postThreadUpdate(threadTs, text);
      lastSentText = text;
      lastSentAt = Date.now();
    } catch {
      // Slack transient failures are best-effort, keep runtime flow uninterrupted.
    } finally {
      sending = false;
    }
  };

  const timer = setInterval(() => {
    void sendPending(false);
  }, 1000);

  return {
    setThread: (threadToken: string) => {
      threadTs = String(threadToken || "").trim();
    },
    push: async (text: string, options?: { immediate?: boolean }) => {
      if (stopped) {
        return;
      }
      const normalized = normalizeThreadUpdateText(text);
      if (!normalized) {
        return;
      }

      const pendingLength = pending.join(separator).length;
      const additionalLength = normalized.length + (pending.length > 0 ? separator.length : 0);
      if (pending.length > 0 && pendingLength + additionalLength > maxChars) {
        await sendPending(true);
      }

      if (pending[pending.length - 1] !== normalized) {
        pending.push(normalized);
      }

      if (options?.immediate) {
        await sendPending(true);
      } else {
        await sendPending(false);
      }
    },
    stop: async () => {
      clearInterval(timer);
      await sendPending(true);
      stopped = true;
    }
  };
}

function createCodexProgressRelay(
  postUpdate: ((text: string) => Promise<void> | void) | null,
  intervalMs: number
): {
  push: (update: string) => Promise<void>;
  stop: () => Promise<void>;
} {
  if (!postUpdate) {
    return {
      push: async () => undefined,
      stop: async () => undefined
    };
  }

  let pending: string[] = [];
  let sending = false;
  let stopped = false;
  let lastSentAt = 0;
  let lastSentText = "";

  const sendPending = async (force: boolean): Promise<void> => {
    if (sending || stopped || pending.length === 0) {
      return;
    }
    const now = Date.now();
    if (!force && lastSentAt > 0 && now - lastSentAt < intervalMs) {
      return;
    }

    const text = pending.join("\n\n──────────\n\n");
    if (!force && text === lastSentText) {
      return;
    }

    pending = [];
    sending = true;
    try {
      await postUpdate(text);
      lastSentText = text;
      lastSentAt = Date.now();
    } catch {
      // Ignore Slack transient failures; progress reporting is best-effort.
    } finally {
      sending = false;
    }
  };

  const timer = setInterval(() => {
    void sendPending(false);
  }, 1000);

  return {
    push: async (update: string) => {
      const text = normalizeProgressUpdate(update);
      if (!text || stopped) {
        return;
      }
      if (pending[pending.length - 1] !== text) {
        pending.push(text);
      }
      await sendPending(false);
    },
    stop: async () => {
      clearInterval(timer);
      await sendPending(true);
      stopped = true;
    }
  };
}

function normalizeProgressUpdate(update: string): string {
  const text = String(update || "").trim();
  if (!text) {
    return "";
  }
  return text.length > 700 ? `${text.slice(0, 697)}...` : text;
}

function normalizeThreadUpdateText(update: string): string {
  const text = String(update || "").trim();
  if (!text) {
    return "";
  }
  const maxLength = Math.max(1200, Number(process.env.ISSUE_HUNTER_SLACK_MESSAGE_MAX_CHARS || 3200));
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 18))}... (truncated)`;
}

function normalizeIssueCommentBody(body: string): string {
  return stripIssueHunterMarker(String(body || "").trim().replace(/\r\n/g, "\n"));
}

function truncateForThread(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, Math.max(0, maxLength - 18))}... (truncated)`;
}

function resolveTriageNeedsProcessing(result: Record<string, unknown>): boolean {
  const direct = result.needs_processing ?? result.needsProcessing;
  if (typeof direct === "boolean") {
    return direct;
  }
  if (typeof direct === "string") {
    const normalized = direct.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return false;
}

function resolveTriageNextStep(
  result: Record<string, unknown>,
  planModeEnabled: boolean,
  needsProcessing: boolean
): "implement" | "plan" | "confirm" | "ignore" {
  const raw = String(result.next_step ?? result.nextStep ?? result.action ?? "").trim().toLowerCase();
  if (raw) {
    if (
      raw === "implement" ||
      raw === "execute" ||
      raw === "process" ||
      raw.includes("进入开发") ||
      raw.includes("开始实现") ||
      raw.includes("处理")
    ) {
      return "implement";
    }
    if (
      raw === "plan" ||
      raw === "design" ||
      raw === "update" ||
      raw === "update_plan" ||
      raw === "await_approval" ||
      raw === "awaiting_approval" ||
      raw.includes("等待审批") ||
      raw.includes("设计") ||
      raw.includes("更新方案") ||
      raw.includes("先出方案")
    ) {
      return "plan";
    }
    if (
      raw === "confirm" ||
      raw === "await_confirm" ||
      raw === "awaiting_confirm" ||
      raw.includes("等待确认") ||
      raw.includes("待确认")
    ) {
      return "confirm";
    }
    if (
      raw === "ignore" ||
      raw === "skip" ||
      raw === "no_action" ||
      raw.includes("不处理") ||
      raw.includes("暂不处理") ||
      raw.includes("忽略")
    ) {
      return "ignore";
    }
  }

  if (!needsProcessing) {
    return "ignore";
  }
  return planModeEnabled ? "plan" : "implement";
}

function triggerTypeLabel(triggerType: IssueTaskInput["triggerType"]): string {
  if (triggerType === "new_comment") {
    return "GitHub 新评论";
  }
  if (triggerType === "slack_signal") {
    return "Slack 新指令";
  }
  if (triggerType === "retry_failed") {
    return "失败重试";
  }
  if (triggerType === "stale_recovery") {
    return "陈旧任务恢复";
  }
  if (triggerType === "manual") {
    return "手动触发";
  }
  return "新 issue";
}

function hasPendingSlackSignal(record: IssueExecutionRecord | null): boolean {
  if (!record) {
    return false;
  }
  const signalAt = String(record.lastSlackSignalAt || "").trim();
  if (!signalAt) {
    return false;
  }
  const handledAt = String(record.lastHandledSlackSignalAt || "").trim();
  return signalAt !== handledAt;
}

function findLatestExternalComment(comments: Record<string, unknown>[]): { id: number; createdAt: string } {
  let maxId = 0;
  let createdAt = "";
  for (const comment of comments) {
    const body = String(comment.body ?? "");
    if (isIssueHunterManagedComment(body)) {
      continue;
    }

    const id = Number(comment.id);
    if (Number.isFinite(id) && id > maxId) {
      maxId = id;
      createdAt = String(comment.created_at ?? comment.updated_at ?? "");
    }
  }
  return { id: maxId, createdAt };
}

function withSyntheticSignalComments(
  comments: Record<string, unknown>[],
  triggerType: IssueTaskInput["triggerType"],
  slackSignalText: string
): Record<string, unknown>[] {
  if (triggerType !== "slack_signal") {
    return comments;
  }

  const signalText = String(slackSignalText || "").trim();
  if (!signalText) {
    return comments;
  }

  const synthetic = {
    id: "slack-signal",
    body: `User sent a new Slack thread instruction:\n\n${signalText}`,
    created_at: new Date().toISOString(),
    user: { login: "slack-thread-user", type: "User" }
  };
  return [...comments, synthetic];
}

function buildImplementUserMessage(
  issue: Record<string, unknown>,
  comments: Record<string, unknown>[],
  triggerType: IssueTaskInput["triggerType"],
  slackSignalText: string,
  existingRecord?: IssueExecutionRecord | null
): string {
  const issueBody = String(issue.body ?? "").trim();
  const issueTitle = String(issue.title ?? "").trim();

  if (triggerType === "slack_signal") {
    const signal = String(slackSignalText || "").trim();
    if (signal) {
      return signal;
    }
  }

  if (triggerType === "new_comment" || triggerType === "approval") {
    const latestExternal = findLatestExternalCommentBody(comments);
    if (latestExternal) {
      return latestExternal;
    }
  }

  if (issueBody) {
    return issueBody;
  }
  if (issueTitle) {
    return issueTitle;
  }
  return "Please inspect the current issue context and decide the next implementation steps.";
}

function buildImplementUserMessageFromApproval(
  issue: Record<string, unknown>,
  approvalComment: string,
  existingRecord?: IssueExecutionRecord | null
): string {
  const planSummary = String(existingRecord?.summary || "").trim();
  const planDetails = String(existingRecord?.solution || "").trim();
  const issueBody = String(issue.body ?? "").trim();
  const approvedComment = String(approvalComment || "").trim();

  const message = [
    "User has explicitly approved the proposal for this issue. Start implementation now.",
    approvedComment ? `Latest approval comment:\n${approvedComment}` : "",
    planSummary ? `Approved plan summary:\n${planSummary}` : "",
    planDetails ? `Approved design and implementation plan:\n${planDetails}` : "",
    issueBody ? `Original issue body:\n${issueBody}` : ""
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  return message || "User has explicitly approved. Proceed with implementation now.";
}

function isExplicitApprovalComment(body: string): boolean {
  const text = String(body || "").trim();
  if (!text) {
    return false;
  }

  // Only treat short command-like replies as explicit approval.
  if (text.length > 120) {
    return false;
  }
  if (/^#{1,6}\s/.test(text) || text.includes("```")) {
    return false;
  }

  const normalized = text.replace(/\s+/g, " ").trim().toLowerCase();
  const negativePatterns = [
    /\bnot\s+approve\b/i,
    /\bdo\s+not\s+approve\b/i,
    /\bdisapprove\b/i,
    /\breject\b/i,
    /\bwait\b/i,
    /\bhold\b/i,
    /不同意/,
    /不通过/,
    /不要开始/,
    /先别做/,
    /暂不处理/
  ];
  if (negativePatterns.some((pattern) => pattern.test(text) || pattern.test(normalized))) {
    return false;
  }

  const englishApproval = /^(approve|approved|lgtm)(?:[\s,，。.!！;；:：-].*)?$/i;
  if (englishApproval.test(normalized)) {
    return true;
  }

  const chineseApproval = /^(同意|通过|批准|可以开始|开始实现|按方案实现|按方案处理|继续实现)(?:[，,。.!！;；:：-].*)?$/;
  return chineseApproval.test(text);
}

function findLatestExternalCommentBody(comments: Record<string, unknown>[]): string {
  let chosenId = 0;
  let chosenBody = "";
  for (const comment of comments) {
    const body = String(comment.body ?? "").trim();
    if (!body || isIssueHunterManagedComment(body)) {
      continue;
    }

    const id = Number(comment.id);
    if (Number.isFinite(id)) {
      if (id >= chosenId) {
        chosenId = id;
        chosenBody = body;
      }
      continue;
    }

    if (!chosenBody) {
      chosenBody = body;
    }
  }
  return chosenBody;
}

const ISSUE_HUNTER_COMMENT_MARKER = "<!-- issue-hunter:auto -->";
const ISSUE_HUNTER_IDEMPOTENCY_PREFIX = "<!-- issue-hunter:idempotency:";

function appendIssueHunterMarker(body: string, idempotencyKey?: string): string {
  const normalized = String(body || "").trim();
  if (!normalized) {
    return "";
  }
  if (normalized.includes(ISSUE_HUNTER_COMMENT_MARKER)) {
    return normalized;
  }
  const key = String(idempotencyKey || "").trim();
  if (!key) {
    return `${normalized}\n\n${ISSUE_HUNTER_COMMENT_MARKER}`;
  }
  return `${normalized}\n\n${ISSUE_HUNTER_COMMENT_MARKER}\n${ISSUE_HUNTER_IDEMPOTENCY_PREFIX}${key} -->`;
}

function stripIssueHunterMarker(body: string): string {
  const base = String(body || "")
    .replace(new RegExp(`\\n?\\n?${escapeRegExp(ISSUE_HUNTER_IDEMPOTENCY_PREFIX)}[^\\n]*-->\\s*$`), "")
    .replace(new RegExp(`\\n?\\n?${escapeRegExp(ISSUE_HUNTER_COMMENT_MARKER)}\\s*$`), "");
  return base.trim();
}

function isIssueHunterManagedComment(body: string): boolean {
  return String(body || "").includes(ISSUE_HUNTER_COMMENT_MARKER);
}

function extractIssueHunterIdempotencyKey(body: string): string {
  const match = String(body || "").match(/<!--\s*issue-hunter:idempotency:([^\s]+)\s*-->/i);
  return String(match?.[1] || "").trim();
}

function escapeRegExp(value: string): string {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createLimiter(concurrency: number) {
  const queue: Array<() => void> = [];
  let active = 0;

  return async <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const execute = () => {
        active += 1;
        task()
          .then(resolve, reject)
          .finally(() => {
            active -= 1;
            const next = queue.shift();
            if (next) {
              next();
            }
          });
      };

      if (active < concurrency) {
        execute();
      } else {
        queue.push(execute);
      }
    });
}

function deriveThreadTokenAliases(token: string): string[] {
  const raw = String(token || "").trim();
  if (!raw) {
    return [];
  }

  const aliases = new Set<string>([raw]);
  if (raw.startsWith("slack:")) {
    const parts = raw.split(":");
    if (parts.length >= 3) {
      const threadTs = parts.slice(2).join(":").trim();
      if (threadTs) {
        aliases.add(threadTs);
      }
      if (parts[1] && threadTs) {
        aliases.add(`slack:${parts[1]}:${threadTs}`);
      }
    }
  }

  return [...aliases];
}

function isCancellationError(message: string): boolean {
  const text = String(message || "").toLowerCase();
  return text.includes("cancelled by stop request") || text.includes("cancelled by stop command");
}

type IssueFailureCategory = "transient" | "logic" | "config" | "cancelled" | "unknown";

function classifyIssueFailure(message: string): { category: IssueFailureCategory; retryEligible: boolean } {
  const text = String(message || "").toLowerCase();
  if (!text) {
    return { category: "unknown", retryEligible: false };
  }

  const transientPatterns = [
    "eof",
    "timeout",
    "timed out",
    "etimedout",
    "econnreset",
    "connection reset by peer",
    "enotfound",
    "tls handshake timeout",
    "http 429",
    "http 500",
    "http 502",
    "http 503",
    "http 504",
    "socket hang up",
    "rate limit"
  ];
  if (transientPatterns.some((pattern) => text.includes(pattern))) {
    return { category: "transient", retryEligible: true };
  }

  const configPatterns = [
    "gh auth status",
    "permission denied",
    "forbidden",
    "unauthorized",
    "not authenticated",
    "invalid token",
    "missing slack bot token",
    "not found or disabled",
    "command not found"
  ];
  if (configPatterns.some((pattern) => text.includes(pattern))) {
    return { category: "config", retryEligible: false };
  }

  const logicPatterns = [
    "cannot parse",
    "json",
    "implementation completed but no pr url",
    "invalid worker args",
    "issue is already running",
    "workflow violation"
  ];
  if (logicPatterns.some((pattern) => text.includes(pattern))) {
    return { category: "logic", retryEligible: false };
  }

  return { category: "unknown", retryEligible: false };
}

function shouldRetryFailedRecord(record: IssueExecutionRecord | null): boolean {
  if (!record || record.state !== "failed") {
    return false;
  }

  const autoRetry = String(process.env.FAILED_ISSUE_AUTO_RETRY || "")
    .trim()
    .toLowerCase();
  const forceRetryAnyFailure = ["1", "true", "yes", "on"].includes(autoRetry);
  const retryByCategory =
    record.failureRetryEligible === true ||
    String(record.failureCategory || "").trim().toLowerCase() === "transient";
  if (!forceRetryAnyFailure && !retryByCategory) {
    return false;
  }

  const cooldownDefault = retryByCategory ? 120 : 300;
  const cooldownSeconds = Math.max(0, Number(process.env.FAILED_ISSUE_RETRY_COOLDOWN_SECONDS || cooldownDefault));
  if (!Number.isFinite(cooldownSeconds)) {
    return false;
  }

  const updatedAt = Date.parse(record.updatedAt || "");
  if (!Number.isFinite(updatedAt)) {
    return true;
  }

  return Date.now() - updatedAt >= cooldownSeconds * 1000;
}

function shouldRecoverStaleInFlightRecord(record: IssueExecutionRecord | null): boolean {
  if (!record) {
    return false;
  }

  const state = record.state;
  if (state !== "triaging" && state !== "scheduled" && state !== "implementing") {
    return false;
  }

  const heartbeatAt = Date.parse(record.lastWorkerHeartbeatAt || "");
  const updatedAt = Date.parse(record.updatedAt || "");
  const baseline = Number.isFinite(heartbeatAt) ? heartbeatAt : updatedAt;
  if (!Number.isFinite(baseline)) {
    return true;
  }

  const staleSeconds = Math.max(60, Number(process.env.ISSUE_HUNTER_STALE_IN_FLIGHT_RETRY_SECONDS || 900));
  if (!Number.isFinite(staleSeconds)) {
    return false;
  }

  return Date.now() - baseline >= staleSeconds * 1000;
}

function buildIssueCycleId(input: {
  issueKey: string;
  triggerType: IssueTaskInput["triggerType"];
  latestExternalCommentId: number;
  latestExternalCommentAt: string;
  lastSlackSignalAt: string;
}): string {
  const commentId = Number.isFinite(input.latestExternalCommentId) ? input.latestExternalCommentId : 0;
  const commentAt = String(input.latestExternalCommentAt || "").trim() || "none";
  const signalAt = String(input.lastSlackSignalAt || "").trim() || "none";
  return [
    input.issueKey,
    input.triggerType,
    `c${commentId}`,
    commentAt,
    signalAt
  ]
    .join("|")
    .replace(/\s+/g, "_");
}
