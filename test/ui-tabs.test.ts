import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("UI tabs", () => {
  const html = readFileSync(resolve(process.cwd(), "public/index.html"), "utf8");

  it("separates issue hunter, board, and slack into tabs", () => {
    expect(html).toContain('data-tab="issue"');
    expect(html).toContain('data-tab="board"');
    expect(html).toContain('data-tab="slack"');
    expect(html).toContain('id="tab-issue"');
    expect(html).toContain('id="tab-board"');
    expect(html).toContain('id="tab-slack"');
  });

  it("keeps repository form focused on local repo fields only", () => {
    const repoForm = html.match(/<form id="repo-form"[\s\S]*?<\/form>/)?.[0] ?? "";
    expect(repoForm).toContain('name="localPath"');
    expect(repoForm).toContain('name="triageWording"');
    expect(repoForm).toContain('name="implementWording"');
    expect(repoForm).toContain('name="ignoreWording"');
    expect(repoForm).not.toContain('name="triageCommand"');
    expect(repoForm).not.toContain('name="implementCommand"');
    expect(repoForm).not.toContain('name="slackChannelIdSelect"');
    expect(repoForm).not.toContain('name="slackChannelId"');
    expect(repoForm).not.toContain('name="slackTransport"');
    expect(repoForm).not.toContain('name="slackEnabled"');
  });

  it("keeps channel-to-repo binding in slack tab", () => {
    const slackTabIndex = html.indexOf('id="tab-slack"');
    const boardTabIndex = html.indexOf('id="tab-board"');
    const slackFormIndex = html.indexOf('id="slack-form"');
    const bindingTableIndex = html.indexOf('id="binding-table"');
    expect(boardTabIndex).toBeGreaterThan(-1);
    expect(slackTabIndex).toBeGreaterThan(-1);
    expect(slackFormIndex).toBeGreaterThan(slackTabIndex);
    expect(bindingTableIndex).toBeGreaterThan(slackTabIndex);
  });

  it("avoids duplicated slack token/app name inputs in wizard", () => {
    expect(html).not.toContain('id="slack-bot-token-test"');
    expect(html).not.toContain('id="btn-autofill-app"');
    expect(html).not.toContain('name="appDisplayName"');
    expect(html).not.toContain('name="botDisplayName"');
  });
});
