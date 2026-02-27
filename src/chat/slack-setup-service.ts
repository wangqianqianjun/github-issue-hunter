import { WebClient } from "@slack/web-api";

export class SlackSetupService {
  constructor(private readonly defaultTokenResolver: () => Promise<string>) {}

  async authTest(botTokenFromRequest: string): Promise<Record<string, unknown>> {
    const token = await this.resolveToken(botTokenFromRequest);
    if (!token) {
      return { ok: false, error: "Slack bot token is required" };
    }

    try {
      const client = new WebClient(token);
      const response = await client.auth.test();
      return {
        ok: true,
        response: response
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async listChannels(botTokenFromRequest: string): Promise<Record<string, unknown>> {
    const token = await this.resolveToken(botTokenFromRequest);
    if (!token) {
      return { ok: false, error: "Slack bot token is required", channels: [] };
    }

    try {
      const client = new WebClient(token);
      const channels: Array<{ id: string; name: string; is_private: boolean }> = [];
      let cursor: string | undefined;

      do {
        const response = await client.conversations.list({
          types: "public_channel,private_channel",
          limit: 200,
          cursor
        });

        for (const channel of response.channels ?? []) {
          channels.push({
            id: channel.id ?? "",
            name: channel.name ?? channel.id ?? "unknown",
            is_private: Boolean(channel.is_private)
          });
        }

        cursor = response.response_metadata?.next_cursor;
      } while (cursor);

      return {
        ok: true,
        channels
      };
    } catch (error) {
      return {
        ok: false,
        channels: [],
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async readAppInfo(botTokenFromRequest: string): Promise<Record<string, unknown>> {
    const token = await this.resolveToken(botTokenFromRequest);
    if (!token) {
      return { ok: false, error: "Slack bot token is required" };
    }

    try {
      const client = new WebClient(token);
      const auth = await client.auth.test();
      const teamName = auth.team ?? "";
      let botName = "";

      if (auth.bot_id) {
        try {
          const botInfo = await client.bots.info({ bot: auth.bot_id });
          botName = botInfo.bot?.name ?? "";
        } catch {
          // fallback to auth.user when bot info scope not available
        }
      }

      if (!botName) {
        botName = auth.user ?? "";
      }

      return {
        ok: true,
        appDisplayName: teamName ? `${teamName} Issue Hunter` : "Issue Hunter",
        botDisplayName: botName || "Issue Hunter Bot",
        teamName
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      };
    }
  }

  private async resolveToken(botTokenFromRequest: string): Promise<string> {
    if (botTokenFromRequest?.trim()) {
      return botTokenFromRequest.trim();
    }
    return this.defaultTokenResolver();
  }
}
