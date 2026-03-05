import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { IssueExecutionRecord, RepositoryConfig } from "../types/config.js";
import type { GitHubClientLike, WorkspacePreparation } from "./issue-engine.js";
import { WorktreeManager } from "./worktree-manager.js";
import { runShell } from "../utils/shell.js";

export interface WorkspaceManagerOptions {
  workspaceRoot: string;
  keepWorktrees: boolean;
}

export class WorkspaceManager {
  private readonly worktreeManager = new WorktreeManager();

  constructor(private readonly options: WorkspaceManagerOptions) {}

  async prepare(
    repo: RepositoryConfig,
    issue: Record<string, unknown>,
    comments: Record<string, unknown>[],
    imageUrls: string[],
    github: GitHubClientLike,
    existingRecord?: IssueExecutionRecord | null
  ): Promise<WorkspacePreparation> {
    const issueNumber = Number(issue.number);
    const archiveDir = resolve(this.options.workspaceRoot, "artifacts", repo.id, `issue-${issueNumber}`);
    await mkdir(archiveDir, { recursive: true });

    const imagesDir = join(archiveDir, "images");
    const imageFiles = github.downloadImages ? await github.downloadImages(imageUrls, imagesDir) : [];

    const preferredWorktreePath = String(existingRecord?.issueWorktreePath || "").trim();
    const preferredWorktreeBranch = String(existingRecord?.issueWorktreeBranch || "").trim();
    const plan = this.worktreeManager.plan(
      repo.localPath,
      repo.id,
      issueNumber,
      preferredWorktreePath,
      preferredWorktreeBranch
    );
    let createdWorktree = false;
    let reusedWorktree = false;
    let workingDir = "";

    if (await isRegisteredWorktree(repo.localPath, plan.path)) {
      reusedWorktree = true;
      workingDir = plan.path;
    } else {
      const branchExists = await doesLocalBranchExist(repo.localPath, plan.branch);
      const addCommand = branchExists
        ? `git -C "${repo.localPath}" worktree add "${plan.path}" "${plan.branch}"`
        : `git -C "${repo.localPath}" worktree add -b "${plan.branch}" "${plan.path}" HEAD`;
      const addResult = await runShell(addCommand, repo.localPath);
      if (addResult.code !== 0) {
        throw new Error(
          `Failed to create/reuse issue worktree (${repo.owner}/${repo.repo}#${issueNumber}): ${
            addResult.stderr || addResult.stdout || `git exit ${addResult.code}`
          }`
        );
      }
      createdWorktree = true;
      workingDir = plan.path;
    }

    const contextData = {
      repository: {
        owner: repo.owner,
        repo: repo.repo,
        localPath: repo.localPath,
        worktreePath: workingDir,
        worktreeBranch: plan.branch,
        worktreeCreated: createdWorktree,
        worktreeReused: reusedWorktree
      },
      issue,
      comments,
      imageUrls,
      imageFiles
    };

    const contextFile = join(archiveDir, "context.json");
    await writeFile(contextFile, JSON.stringify(contextData, null, 2), "utf8");

    return {
      contextFile,
      worktreePath: workingDir,
      worktreeBranch: plan.branch,
      worktreeCreated: createdWorktree,
      cleanup: async () => undefined
    };
  }
}

async function isRegisteredWorktree(repoLocalPath: string, worktreePath: string): Promise<boolean> {
  const normalized = resolve(String(worktreePath || "").trim());
  if (!normalized) {
    return false;
  }

  const listResult = await runShell(`git -C "${repoLocalPath}" worktree list --porcelain`, repoLocalPath);
  if (listResult.code !== 0) {
    return false;
  }

  const lines = String(listResult.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith("worktree ")) {
      continue;
    }
    const candidate = resolve(line.slice("worktree ".length).trim());
    if (candidate === normalized) {
      return true;
    }
  }
  return false;
}

async function doesLocalBranchExist(repoLocalPath: string, branchName: string): Promise<boolean> {
  const branch = String(branchName || "").trim();
  if (!branch) {
    return false;
  }
  const result = await runShell(`git -C "${repoLocalPath}" show-ref --verify --quiet "refs/heads/${branch}"`, repoLocalPath);
  return result.code === 0;
}
