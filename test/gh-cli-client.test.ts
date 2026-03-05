import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { GhCliClient } from "../src/clients/gh-cli-client.js";

describe("GhCliClient", () => {
  it("uses gh api to list issues and gh issue comment to reply", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string; input?: string }> = [];

    const runner = async (
      command: string,
      args: string[],
      options?: { cwd?: string; input?: string }
    ) => {
      calls.push({ command, args, cwd: options?.cwd, input: options?.input });

      if (args[0] === "api") {
        return {
          code: 0,
          stdout: JSON.stringify([
            { number: 1, title: "a" },
            { number: 2, title: "b", pull_request: { url: "..." } }
          ]),
          stderr: ""
        };
      }

      return {
        code: 0,
        stdout: "",
        stderr: ""
      };
    };

    const client = new GhCliClient(
      {
        owner: "acme",
        repo: "web",
        localPath: "/tmp/acme-web"
      },
      runner
    );

    const issues = await client.listOpenIssues();
    await client.createIssueComment(1, "正在评估");

    expect(issues).toHaveLength(1);
    expect(calls[0].command).toBe("gh");
    expect(calls[0].args[0]).toBe("api");
    expect(calls[0].args.join(" ")).toContain("/repos/acme/web/issues?");

    expect(calls[1].command).toBe("gh");
    expect(calls[1].args.slice(0, 4)).toEqual(["issue", "comment", "1", "--repo"]);
    expect(calls[1].args).toContain("acme/web");
    expect(calls[1].args).toContain("正在评估");
  });

  it("uploads local image links to media branch and rewrites comment markdown", async () => {
    const calls: Array<{ command: string; args: string[]; cwd?: string; input?: string }> = [];
    const dir = mkdtempSync(join(tmpdir(), "hunter-gh-media-"));
    const imagePath = join(dir, "filter-ui-1280.png");
    writeFileSync(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const runner = async (
      command: string,
      args: string[],
      options?: { cwd?: string; input?: string }
    ) => {
      calls.push({ command, args, cwd: options?.cwd, input: options?.input });

      if (args[0] !== "api") {
        return { code: 0, stdout: "", stderr: "" };
      }

      const endpoint = args.find((item) => item.startsWith("/repos/")) || "";
      if (endpoint.includes("/git/ref/heads/github-issue-hunter-media")) {
        return {
          code: 0,
          stdout: JSON.stringify({ ref: "refs/heads/github-issue-hunter-media" }),
          stderr: ""
        };
      }

      if (endpoint.includes("/contents/") && endpoint.includes("?ref=github-issue-hunter-media")) {
        return {
          code: 1,
          stdout: "",
          stderr: "HTTP 404 Not Found"
        };
      }

      if (args.includes("--method") && args.includes("PUT") && endpoint.includes("/contents/")) {
        return {
          code: 0,
          stdout: JSON.stringify({ content: { path: "issue-media/issue-3/file.png" } }),
          stderr: ""
        };
      }

      return {
        code: 0,
        stdout: JSON.stringify({}),
        stderr: ""
      };
    };

    const client = new GhCliClient(
      {
        owner: "acme",
        repo: "web",
        localPath: dir,
        mediaRepo: "acme/media",
        mediaBranch: "github-issue-hunter-media"
      },
      runner
    );

    await client.createIssueComment(3, `截图：\n[filter-ui-1280.png](${imagePath})`);

    const commentCall = calls.find((item) => item.command === "gh" && item.args[0] === "issue" && item.args[1] === "comment");
    expect(commentCall).toBeTruthy();
    const bodyIndex = commentCall!.args.indexOf("--body");
    const body = commentCall!.args[bodyIndex + 1];
    expect(body).toContain("https://github.com/acme/media/blob/github-issue-hunter-media/");
    expect(body).toContain("?raw=1");
    expect(body).toContain("![filter-ui-1280.png](");
    expect(body).not.toContain(imagePath);

    const putCall = calls.find(
      (item) => item.command === "gh" && item.args[0] === "api" && item.args.includes("--method") && item.args.includes("PUT")
    );
    expect(putCall).toBeTruthy();
    expect(String(putCall?.input || "")).toContain("\"branch\":\"github-issue-hunter-media\"");
  });
});
