import { mkdir, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";

import type { GitHubClientLike } from "../core/issue-engine.js";
import { runCommand, type CommandResult } from "../utils/run-command.js";

export interface GhCliClientOptions {
  owner: string;
  repo: string;
  localPath: string;
}

type CommandRunner = (command: string, args: string[], options?: { cwd?: string; input?: string }) => Promise<CommandResult>;

export class GhCliClient implements GitHubClientLike {
  private readonly repoName: string;

  constructor(
    private readonly options: GhCliClientOptions,
    private readonly commandRunner: CommandRunner = runCommand
  ) {
    this.repoName = `${options.owner}/${options.repo}`;
  }

  async listOpenIssues(): Promise<Record<string, unknown>[]> {
    const payload = await this.runGhJson([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `/repos/${this.repoName}/issues?state=open&sort=created&direction=asc&per_page=100`
    ]);

    return Array.isArray(payload)
      ? payload.filter((item) => !(item as { pull_request?: unknown }).pull_request)
      : [];
  }

  async getIssue(issueNumber: number): Promise<Record<string, unknown>> {
    const payload = await this.runGhJson([
      "api",
      "-H",
      "Accept: application/vnd.github.full+json",
      `/repos/${this.repoName}/issues/${issueNumber}`
    ]);
    return payload as Record<string, unknown>;
  }

  async listIssueComments(issueNumber: number): Promise<Record<string, unknown>[]> {
    const payload = await this.runGhJson([
      "api",
      "-H",
      "Accept: application/vnd.github.full+json",
      `/repos/${this.repoName}/issues/${issueNumber}/comments`
    ]);

    return Array.isArray(payload) ? payload : [];
  }

  async createIssueComment(issueNumber: number, body: string): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.commandRunner(
        "gh",
        ["issue", "comment", String(issueNumber), "--repo", this.repoName, "--body", body],
        { cwd: this.options.localPath }
      );
    } catch (error) {
      throw new Error(
        `Failed to run gh command. Ensure GitHub CLI is installed and available in PATH. Original error: ${String(error)}`
      );
    }

    if (result.code !== 0) {
      throw new Error(`gh issue comment failed: ${result.stderr || result.stdout}. Run 'gh auth status' in this repository.`);
    }
  }

  async closeIssue(issueNumber: number): Promise<void> {
    let result: CommandResult;
    try {
      result = await this.commandRunner(
        "gh",
        ["issue", "close", String(issueNumber), "--repo", this.repoName],
        { cwd: this.options.localPath }
      );
    } catch (error) {
      throw new Error(
        `Failed to run gh command. Ensure GitHub CLI is installed and available in PATH. Original error: ${String(error)}`
      );
    }

    if (result.code !== 0) {
      throw new Error(`gh issue close failed: ${result.stderr || result.stdout}. Run 'gh auth status' in this repository.`);
    }
  }

  async downloadImages(urls: string[], outputDir: string): Promise<string[]> {
    if (!urls.length) {
      return [];
    }

    await mkdir(outputDir, { recursive: true });
    const token = await this.tryGetGhToken();
    const written: string[] = [];

    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      try {
        const response = await fetch(url, {
          headers: token
            ? {
                Authorization: `Bearer ${token}`
              }
            : undefined
        });

        if (!response.ok) {
          continue;
        }

        const bytes = Buffer.from(await response.arrayBuffer());
        const suffix = extname(new URL(url).pathname) || ".bin";
        const output = join(outputDir, `image-${i + 1}${suffix}`);
        await writeFile(output, bytes);
        written.push(output);
      } catch {
        // keep processing remaining images
      }
    }

    return written;
  }

  private async runGhJson(args: string[]): Promise<unknown> {
    let result: CommandResult;
    try {
      result = await this.commandRunner("gh", args, { cwd: this.options.localPath });
    } catch (error) {
      throw new Error(
        `Failed to run gh command. Ensure GitHub CLI is installed and available in PATH. Original error: ${String(error)}`
      );
    }
    if (result.code !== 0) {
      throw new Error(`gh command failed: ${result.stderr || result.stdout}. Run 'gh auth status' in this repository.`);
    }

    try {
      return JSON.parse(result.stdout);
    } catch (error) {
      throw new Error(`Failed to parse gh JSON output: ${String(error)}; output=${result.stdout}`);
    }
  }

  private async tryGetGhToken(): Promise<string> {
    try {
      const result = await this.commandRunner("gh", ["auth", "token"], { cwd: this.options.localPath });
      if (result.code !== 0) {
        return "";
      }
      return result.stdout.trim();
    } catch {
      return "";
    }
  }
}
