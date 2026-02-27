import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApiApp } from "../src/api/app.js";
import { ConfigStore } from "../src/core/config-store.js";
describe("API config endpoints", () => {
    it("returns config and supports repository upsert", async () => {
        const dir = mkdtempSync(join(tmpdir(), "hunter-api-"));
        const store = new ConfigStore(join(dir, "config.json"));
        const app = await createApiApp({
            configStore: store,
            startService: async () => undefined,
            stopService: async () => undefined,
            runOnce: async () => undefined,
            getServiceStatus: async () => ({ running: false, activeTasks: 0, queueLength: 0, lastRunAt: "", lastError: "" })
        });
        const initial = await request(app).get("/api/config");
        expect(initial.status).toBe(200);
        expect(initial.body.repositories).toHaveLength(0);
        const upsert = await request(app).post("/api/repositories").send({
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
        expect(upsert.status).toBe(200);
        const after = await request(app).get("/api/config");
        expect(after.body.repositories).toHaveLength(1);
        expect(after.body.repositories[0].owner).toBe("acme");
    });
});
