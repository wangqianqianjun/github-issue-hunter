import { describe, expect, it } from "vitest";

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
});
