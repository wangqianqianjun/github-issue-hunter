import { describe, expect, it } from "vitest";
import { buildSlackManifest } from "../src/chat/slack-manifest.js";
describe("Slack manifest", () => {
    it("generates events api request url and required bot scopes", () => {
        const manifest = buildSlackManifest({
            appDisplayName: "Issue Hunter",
            botDisplayName: "Issue Hunter Bot",
            webhookBaseUrl: "https://hunter.example.com",
            useSocketMode: false
        });
        expect(manifest.display_information.name).toBe("Issue Hunter");
        expect(manifest.features.bot_user.display_name).toBe("Issue Hunter Bot");
        expect(manifest.oauth_config.scopes.bot).toContain("chat:write");
        expect(manifest.settings.event_subscriptions.request_url).toBe("https://hunter.example.com/api/webhooks/slack");
    });
});
