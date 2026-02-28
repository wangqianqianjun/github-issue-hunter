import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import type { RepositoryConfig } from "../types/config.js";
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
    github: GitHubClientLike
  ): Promise<WorkspacePreparation> {
    const issueNumber = Number(issue.number);
    const archiveDir = resolve(this.options.workspaceRoot, "artifacts", repo.id, `issue-${issueNumber}`);
    await mkdir(archiveDir, { recursive: true });

    const imagesDir = join(archiveDir, "images");
    const imageFiles = github.downloadImages ? await github.downloadImages(imageUrls, imagesDir) : [];

    const plan = this.worktreeManager.plan(repo.localPath, repo.id, issueNumber);
    let createdWorktree = false;
    let workingDir = repo.localPath;

    const addCommand = `git -C "${repo.localPath}" worktree add -b "${plan.branch}" "${plan.path}" HEAD`;
    const addResult = await runShell(addCommand, repo.localPath);
    if (addResult.code === 0) {
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
        worktreeCreated: createdWorktree
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
      cleanup: async () => {
        if (!createdWorktree || this.options.keepWorktrees) {
          return;
        }
        await runShell(`git -C "${repo.localPath}" worktree remove --force "${plan.path}"`, repo.localPath);
        await runShell(`git -C "${repo.localPath}" branch -D "${plan.branch}"`, repo.localPath);
      }
    };
  }
}
