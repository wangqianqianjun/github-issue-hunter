import { mkdir, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { GitHubClientLike } from "../core/issue-engine.js";

export interface GitHubClientOptions {
  owner: string;
  repo: string;
  token: string;
  apiBase?: string;
}

export class GitHubClient implements GitHubClientLike {
  private readonly apiBase: string;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "");
  }

  async listOpenIssues(): Promise<Record<string, unknown>[]> {
    const data = await this.request(
      "GET",
      `/repos/${this.options.owner}/${this.options.repo}/issues?state=open&sort=created&direction=asc&per_page=100`
    );
    return Array.isArray(data) ? data.filter((item) => !(item as { pull_request?: unknown }).pull_request) : [];
  }

  async getIssue(issueNumber: number): Promise<Record<string, unknown>> {
    return (await this.request(
      "GET",
      `/repos/${this.options.owner}/${this.options.repo}/issues/${issueNumber}`
    )) as Record<string, unknown>;
  }

  async listIssueComments(issueNumber: number): Promise<Record<string, unknown>[]> {
    const data = await this.request(
      "GET",
      `/repos/${this.options.owner}/${this.options.repo}/issues/${issueNumber}/comments`
    );
    return Array.isArray(data) ? data : [];
  }

  async createIssueComment(issueNumber: number, body: string): Promise<void> {
    await this.request(
      "POST",
      `/repos/${this.options.owner}/${this.options.repo}/issues/${issueNumber}/comments`,
      { body }
    );
  }

  async closeIssue(issueNumber: number): Promise<void> {
    await this.request("PATCH", `/repos/${this.options.owner}/${this.options.repo}/issues/${issueNumber}`, {
      state: "closed"
    });
  }

  async downloadImages(urls: string[], outputDir: string): Promise<string[]> {
    if (!urls.length) {
      return [];
    }
    await mkdir(outputDir, { recursive: true });

    const written: string[] = [];
    for (let i = 0; i < urls.length; i += 1) {
      const url = urls[i];
      try {
        const response = await fetch(url, { headers: this.authHeaders() });
        if (!response.ok) {
          continue;
        }
        const bytes = Buffer.from(await response.arrayBuffer());
        const guessed = extname(new URL(url).pathname) || extname(basename(url)) || ".bin";
        const out = join(outputDir, `image-${i + 1}${guessed}`);
        await writeFile(out, bytes);
        written.push(out);
      } catch {
        // ignore individual image failures
      }
    }
    return written;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Record<string, unknown> | Record<string, unknown>[]> {
    const response = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "github-issue-hunter-ts"
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }

    if (response.status === 204) {
      return {};
    }

    return (await response.json()) as Record<string, unknown> | Record<string, unknown>[];
  }

  private authHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.options.token}`
    };
  }
}
