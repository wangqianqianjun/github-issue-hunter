export interface SlackManifestInput {
  appDisplayName: string;
  botDisplayName: string;
  webhookBaseUrl: string;
  useSocketMode: boolean;
}

export function buildSlackManifest(input: SlackManifestInput): Record<string, unknown> {
  const requestUrlBase = input.webhookBaseUrl.replace(/\/$/, "");
  const requestUrl = requestUrlBase ? `${requestUrlBase}/api/webhooks/slack` : "";

  return {
    display_information: {
      name: input.appDisplayName,
      description: "GitHub Issue Hunter automation",
      background_color: "#1f2937"
    },
    features: {
      bot_user: {
        display_name: input.botDisplayName,
        always_online: true
      }
    },
    oauth_config: {
      scopes: {
        bot: [
          "app_mentions:read",
          "channels:history",
          "channels:read",
          "chat:write",
          "chat:write.public",
          "groups:history",
          "groups:read"
        ]
      }
    },
    settings: {
      event_subscriptions: {
        ...(input.useSocketMode ? {} : { request_url: requestUrl }),
        bot_events: ["app_mention", "message.channels", "message.groups"]
      },
      interactivity: {
        is_enabled: true,
        ...(input.useSocketMode ? {} : { request_url: requestUrl })
      },
      socket_mode_enabled: input.useSocketMode,
      org_deploy_enabled: false,
      token_rotation_enabled: false
    }
  };
}
