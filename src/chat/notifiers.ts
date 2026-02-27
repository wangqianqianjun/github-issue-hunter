import { WebClient } from "@slack/web-api";

import type { IssueNotifier } from "../core/issue-engine.js";
import type { ChatSlackBridge } from "./vercel-chat-bridge.js";

export class DirectSlackNotifier implements IssueNotifier {
  private readonly client: WebClient;

  constructor(
    private readonly botToken: string,
    private readonly channelId: string
  ) {
    this.client = new WebClient(botToken);
  }

  async postIssueStart(issue: Record<string, unknown>): Promise<string> {
    const issueNumber = String(issue.number ?? "");
    const title = String(issue.title ?? "");
    const htmlUrl = String(issue.html_url ?? "");

    const response = await this.client.chat.postMessage({
      channel: this.channelId,
      text: `Issue Hunter 即将处理 issue #${issueNumber}: ${title}\n${htmlUrl}`
    });

    return response.ts ?? "";
  }

  async postThreadUpdate(threadToken: string, text: string): Promise<void> {
    await this.client.chat.postMessage({
      channel: this.channelId,
      thread_ts: threadToken,
      text
    });
  }
}

export class ChatSdkNotifier implements IssueNotifier {
  constructor(
    private readonly bridge: ChatSlackBridge,
    private readonly channelId: string
  ) {}

  async postIssueStart(issue: Record<string, unknown>): Promise<string> {
    const issueNumber = String(issue.number ?? "");
    const title = String(issue.title ?? "");
    const htmlUrl = String(issue.html_url ?? "");

    const message = await this.bridge.postChannelMessage(
      this.channelId,
      `Issue Hunter 即将处理 issue #${issueNumber}: ${title}\n${htmlUrl}`
    );

    return message.threadId;
  }

  async postThreadUpdate(threadToken: string, text: string): Promise<void> {
    await this.bridge.postThreadMessage(threadToken, text);
  }
}
