import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigStore } from "../src/core/config-store.js";
describe("ConfigStore", () => {
    it("creates default config when file does not exist", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hunter-config-"));
        const store = new ConfigStore(join(dir, "config.json"));
        const config = await store.load();
        expect(config.repositories).toEqual([]);
        expect(config.global.pollIntervalSeconds).toBe(30);
    });
    it("upserts repository with local path and commands", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hunter-config-"));
        const store = new ConfigStore(join(dir, "config.json"));
        await store.upsertRepository({
            id: "repo-1",
            owner: "acme",
            repo: "web",
            localPath: "/tmp/acme-web",
            githubTokenEnv: "GITHUB_TOKEN",
            triageCommand: "codex triage --context {context_file}",
            implementCommand: "codex implement --context {context_file}",
            enabled: true,
            perRepoConcurrency: 1,
            slack: {
                enabled: true,
                channelId: "C123",
                transport: "chat_sdk"
            }
        });
        const config = await store.load();
        expect(config.repositories).toHaveLength(1);
        expect(config.repositories[0].repo).toBe("web");
        expect(config.repositories[0].slack.transport).toBe("chat_sdk");
    });
});
