import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export interface WorktreePlan {
  branch: string;
  path: string;
}

export class WorktreeManager {
  plan(repoLocalPath: string, repoId: string, issueNumber: number): WorktreePlan {
    const suffix = randomUUID().split("-")[0];
    const baseDir = join(repoLocalPath, ".worktrees");
    const branch = `issue-hunter/${repoId}/${issueNumber}-${suffix}`;
    const path = join(baseDir, `issue-${issueNumber}-${suffix}`);
    mkdirSync(baseDir, { recursive: true });
    return { branch, path };
  }
}
