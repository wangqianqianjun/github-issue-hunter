import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";

import type { GitHubClientLike } from "../core/issue-engine.js";
import { runCommand, type CommandResult } from "../utils/run-command.js";

export interface GhCliClientOptions {
  owner: string;
  repo: string;
  localPath: string;
  mediaRepo?: string;
  mediaBranch?: string;
}

type CommandRunner = (command: string, args: string[], options?: { cwd?: string; input?: string }) => Promise<CommandResult>;

const DEFAULT_MEDIA_BRANCH = "github-issue-hunter-media";
const LOCAL_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".svg"]);

interface LocalImageLinkMatch {
  raw: string;
  localPath: string;
  altText: string;
}

export class GhCliClient implements GitHubClientLike {
  private readonly repoName: string;
  private readonly mediaRepoName: string;
  private readonly mediaBranch: string;

  constructor(
    private readonly options: GhCliClientOptions,
    private readonly commandRunner: CommandRunner = runCommand
  ) {
    this.repoName = `${options.owner}/${options.repo}`;
    this.mediaRepoName = parseOwnerRepo(options.mediaRepo) || this.repoName;
    this.mediaBranch = String(options.mediaBranch || "").trim() || DEFAULT_MEDIA_BRANCH;
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
    const rewrittenBody = await this.rewriteLocalImageLinks(body, issueNumber);
    let result: CommandResult;
    try {
      result = await this.commandRunner(
        "gh",
        ["issue", "comment", String(issueNumber), "--repo", this.repoName, "--body", rewrittenBody],
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

  private async rewriteLocalImageLinks(body: string, issueNumber: number): Promise<string> {
    const source = String(body || "");
    if (!source.trim()) {
      return source;
    }

    const candidates = extractLocalImageMarkdownLinks(source);
    if (!candidates.length) {
      return source;
    }

    await this.ensureMediaBranch();
    const uploadedByLocalPath = new Map<string, string>();
    let rewritten = source;

    for (const candidate of candidates) {
      const key = candidate.localPath.toLowerCase();
      let uploadedUrl = uploadedByLocalPath.get(key) || "";
      let replacement = "";
      if (!uploadedUrl) {
        try {
          uploadedUrl = await this.uploadImageToMediaBranch(candidate.localPath, issueNumber);
          uploadedByLocalPath.set(key, uploadedUrl);
        } catch (error) {
          replacement = `> 图片上传失败：${candidate.altText || basename(candidate.localPath)}（${truncateError(error)}）`;
        }
      }

      if (!replacement) {
        replacement = `![${candidate.altText || basename(candidate.localPath)}](${uploadedUrl})`;
      }
      rewritten = rewritten.replace(candidate.raw, replacement);
    }

    return rewritten;
  }

  private async ensureMediaBranch(): Promise<void> {
    const encodedRepo = encodeRepoForApi(this.mediaRepoName);
    const encodedBranch = encodeURIComponent(this.mediaBranch);

    try {
      await this.runGhJson([
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        `/repos/${encodedRepo}/git/ref/heads/${encodedBranch}`
      ]);
      return;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const repoMeta = (await this.runGhJson([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `/repos/${encodedRepo}`
    ])) as Record<string, unknown>;
    const defaultBranch = String(repoMeta.default_branch || "").trim() || "main";
    const baseRef = (await this.runGhJson([
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `/repos/${encodedRepo}/git/ref/heads/${encodeURIComponent(defaultBranch)}`
    ])) as Record<string, unknown>;
    const sha = String((baseRef.object as Record<string, unknown> | undefined)?.sha || "").trim();
    if (!sha) {
      throw new Error(`Failed to resolve default branch head for media repo ${this.mediaRepoName}`);
    }

    const payload = {
      ref: `refs/heads/${this.mediaBranch}`,
      sha
    };
    try {
      await this.runGhJson(
        [
          "api",
          "--method",
          "POST",
          "-H",
          "Accept: application/vnd.github+json",
          `/repos/${encodedRepo}/git/refs`,
          "--input",
          "-"
        ],
        { input: JSON.stringify(payload) }
      );
    } catch (error) {
      if (!isAlreadyExistsError(error)) {
        throw error;
      }
    }
  }

  private async uploadImageToMediaBranch(localPath: string, issueNumber: number): Promise<string> {
    const bytes = await readFile(localPath);
    const maxBytes = Math.max(256 * 1024, Number(process.env.ISSUE_HUNTER_MEDIA_MAX_BYTES || 10 * 1024 * 1024));
    if (bytes.length > maxBytes) {
      throw new Error(`image size ${bytes.length} exceeds limit ${maxBytes}`);
    }

    const digest = createHash("sha256").update(bytes).digest("hex");
    const originalName = sanitizeFileName(basename(localPath) || "image.bin");
    const mediaPath = [
      "issue-media",
      `issue-${Math.max(0, Number(issueNumber) || 0)}`,
      `${digest.slice(0, 16)}-${originalName}`
    ].join("/");

    const encodedRepo = encodeRepoForApi(this.mediaRepoName);
    const endpointPath = encodeContentPathForApi(mediaPath);
    const contentEndpoint = `/repos/${encodedRepo}/contents/${endpointPath}`;

    let existingSha = "";
    try {
      const existing = (await this.runGhJson([
        "api",
        "-H",
        "Accept: application/vnd.github+json",
        `${contentEndpoint}?ref=${encodeURIComponent(this.mediaBranch)}`
      ])) as Record<string, unknown>;
      existingSha = String(existing.sha || "").trim();
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    if (existingSha) {
      return buildMediaBlobRawUrl(this.mediaRepoName, this.mediaBranch, mediaPath);
    }

    const payload: Record<string, unknown> = {
      message: `chore(issue-hunter): upload media for issue #${issueNumber}`,
      content: bytes.toString("base64"),
      branch: this.mediaBranch
    };

    await this.runGhJson(
      [
        "api",
        "--method",
        "PUT",
        "-H",
        "Accept: application/vnd.github+json",
        contentEndpoint,
        "--input",
        "-"
      ],
      { input: JSON.stringify(payload) }
    );

    return buildMediaBlobRawUrl(this.mediaRepoName, this.mediaBranch, mediaPath);
  }

  private async runGhJson(args: string[], options?: { input?: string }): Promise<unknown> {
    const maxAttempts = Math.max(1, Number(process.env.ISSUE_HUNTER_GH_API_MAX_ATTEMPTS || 6));
    let lastError = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let result: CommandResult;
      try {
        result = await this.commandRunner("gh", args, { cwd: this.options.localPath, input: options?.input });
      } catch (error) {
        lastError = `Failed to run gh command. Ensure GitHub CLI is installed and available in PATH. Original error: ${String(error)}`;
        if (attempt < maxAttempts && isRetryableGhError(lastError)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(lastError);
      }

      if (result.code !== 0) {
        lastError = `gh command failed: ${result.stderr || result.stdout}. Run 'gh auth status' in this repository.`;
        if (attempt < maxAttempts && isRetryableGhError(lastError)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(lastError);
      }

      try {
        return JSON.parse(result.stdout);
      } catch (error) {
        lastError = `Failed to parse gh JSON output: ${String(error)}; output=${result.stdout}`;
        if (attempt < maxAttempts && isRetryableGhError(lastError)) {
          await sleep(backoffMs(attempt));
          continue;
        }
        throw new Error(lastError);
      }
    }

    throw new Error(lastError || "gh command failed with unknown error");
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

function extractLocalImageMarkdownLinks(text: string): LocalImageLinkMatch[] {
  const matches: LocalImageLinkMatch[] = [];
  const markdownLinkPattern = /(!?)\[([^\]]*)\]\(([^)\n]+)\)/g;
  let match: RegExpExecArray | null = markdownLinkPattern.exec(text);
  while (match) {
    const raw = String(match[0] || "");
    const alt = String(match[2] || "").trim();
    const targetRaw = String(match[3] || "").trim();
    const localPath = resolveLocalImagePathFromMarkdownTarget(targetRaw);
    if (localPath) {
      matches.push({
        raw,
        localPath,
        altText: alt
      });
    }
    match = markdownLinkPattern.exec(text);
  }
  return matches;
}

function resolveLocalImagePathFromMarkdownTarget(targetRaw: string): string {
  const normalizedTarget = stripMarkdownLinkTarget(targetRaw);
  if (!normalizedTarget) {
    return "";
  }
  const localPath = toLocalPath(normalizedTarget);
  if (!localPath) {
    return "";
  }
  const suffix = extname(localPath).toLowerCase();
  if (!LOCAL_IMAGE_EXTENSIONS.has(suffix)) {
    return "";
  }
  return localPath;
}

function stripMarkdownLinkTarget(targetRaw: string): string {
  const value = String(targetRaw || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("<") && value.endsWith(">")) {
    return value.slice(1, -1).trim();
  }
  const firstWhitespace = value.search(/\s/);
  if (firstWhitespace < 0) {
    return value;
  }
  return value.slice(0, firstWhitespace).trim();
}

function toLocalPath(target: string): string {
  const value = String(target || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith("file://")) {
    try {
      const parsed = new URL(value);
      return decodeURIComponent(parsed.pathname);
    } catch {
      return "";
    }
  }
  if (value.startsWith("/")) {
    return decodeURIComponentSafe(value);
  }
  if (/^[A-Za-z]:\\/.test(value)) {
    return decodeURIComponentSafe(value);
  }
  return "";
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseOwnerRepo(value: string | undefined): string {
  const normalized = String(value || "").trim();
  if (!normalized) {
    return "";
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(normalized)) {
    return "";
  }
  return normalized;
}

function encodeRepoForApi(repoName: string): string {
  return repoName
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function encodeContentPathForApi(path: string): string {
  return String(path || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildMediaBlobRawUrl(repoName: string, branch: string, mediaPath: string): string {
  const normalizedPath = String(mediaPath || "")
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `https://github.com/${repoName}/blob/${encodeURIComponent(branch)}/${normalizedPath}?raw=1`;
}

function sanitizeFileName(name: string): string {
  const normalized = String(name || "image.bin").trim() || "image.bin";
  return normalized.replace(/[^a-zA-Z0-9._-]+/g, "-");
}

function isNotFoundError(error: unknown): boolean {
  const text = String(error || "").toLowerCase();
  return text.includes("404") || text.includes("not found");
}

function isAlreadyExistsError(error: unknown): boolean {
  const text = String(error || "").toLowerCase();
  return text.includes("reference already exists") || text.includes("already exists");
}

function truncateError(error: unknown): string {
  const text = String(error || "").replace(/\s+/g, " ").trim();
  if (!text) {
    return "unknown error";
  }
  if (text.length <= 180) {
    return text;
  }
  return `${text.slice(0, 177)}...`;
}

function isRetryableGhError(message: string): boolean {
  const text = String(message || "").toLowerCase();
  if (!text) {
    return false;
  }
  return (
    text.includes("eof") ||
    text.includes("timeout") ||
    text.includes("timed out") ||
    text.includes("etimedout") ||
    text.includes("econnreset") ||
    text.includes("connection reset by peer") ||
    text.includes("reset by peer") ||
    text.includes("read tcp") ||
    text.includes("enotfound") ||
    text.includes("temporary failure") ||
    text.includes("tls handshake timeout") ||
    text.includes("http 502") ||
    text.includes("http 503") ||
    text.includes("http 504")
  );
}

function backoffMs(attempt: number): number {
  const base = Math.max(100, Number(process.env.ISSUE_HUNTER_GH_API_RETRY_BASE_MS || 400));
  const exp = Math.pow(2, Math.max(0, attempt - 1));
  const jitter = 0.75 + Math.random() * 0.5;
  return Math.min(12_000, Math.floor(base * exp * jitter));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
