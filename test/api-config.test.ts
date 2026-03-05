import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import request from "supertest";
import { describe, expect, it } from "vitest";

import { createApiApp } from "../src/api/app.js";
import {
  DEFAULT_IGNORE_WORDING,
  DEFAULT_IMPLEMENT_WORDING,
  DEFAULT_TRIAGE_WORDING
} from "../src/core/defaults.js";
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
      getServiceHealth: async () => ({
        now: "2026-03-01T00:00:00.000Z",
        service: {
          running: false,
          activeTasks: 0,
          queueLength: 0,
          lastRunAt: "",
          lastError: "",
          runOnceInFlight: false,
          schedulerTickLagMs: 0
        }
      }),
      listBoardCards: async () => [
        {
          issueKey: "acme/web#7",
          repoId: "acme-web",
          repoFullName: "acme/web",
          issueNumber: 7,
          issueUrl: "https://github.com/acme/web/issues/7",
          state: "completed",
          summary: "summary",
          rootCause: "root",
          solution: "solution",
          prUrl: "https://github.com/acme/web/pull/11",
          closedAt: "2026-02-25T00:00:00.000Z",
          updatedAt: "2026-02-25T00:00:00.000Z"
        }
      ],
      getBoardDetail: async (repoId, issueNumber) => {
        if (repoId !== "acme-web" || issueNumber !== 7) {
          return null;
        }
        return {
          issueKey: "acme/web#7",
          repoId: "acme-web",
          repoFullName: "acme/web",
          issueNumber: 7,
          state: "completed",
          issueUrl: "https://github.com/acme/web/issues/7",
          updatedAt: "2026-02-25T00:00:00.000Z",
          closedAt: "2026-02-25T00:00:00.000Z",
          prUrl: "https://github.com/acme/web/pull/11",
          summary: "summary",
          rootCause: "root",
          solution: "solution",
          issue: {
            number: 7,
            title: "Issue title",
            state: "open",
            url: "https://github.com/acme/web/issues/7",
            createdAt: "2026-02-24T00:00:00.000Z",
            updatedAt: "2026-02-25T00:00:00.000Z",
            closedAt: "",
            body: "issue body",
            bodyHtml: "<p>issue body</p>"
          },
          discussion: [
            {
              id: "1",
              author: "bot",
              createdAt: "2026-02-25T00:00:00.000Z",
              updatedAt: "2026-02-25T00:00:00.000Z",
              url: "https://github.com/acme/web/issues/7#issuecomment-1",
              body: "comment body",
              bodyHtml: "<p>comment body</p>"
            }
          ]
        };
      },
      detectRepository: async () => ({ owner: "acme", repo: "web", fullName: "acme/web" }),
      getServiceStatus: async () => ({ running: false, activeTasks: 0, queueLength: 0, lastRunAt: "", lastError: "" }),
      slackSetup: {
        authTest: async (token) => ({ ok: token.startsWith("xoxb-"), team: "acme" }),
        readAppInfo: async () => ({ ok: true, appDisplayName: "acme Issue Hunter", botDisplayName: "acme-bot" }),
        listChannels: async () => ({
          ok: true,
          channels: [
            { id: "C1", name: "general", is_private: false },
            { id: "C2", name: "eng-private", is_private: true }
          ]
        })
      }
    });

    const initial = await request(app).get("/api/config");
    expect(initial.status).toBe(200);
    expect(initial.body.repositories).toHaveLength(0);

    const detectedAgents = await request(app).get("/api/agents/detect");
    expect(detectedAgents.status).toBe(200);
    expect(typeof detectedAgents.body.codex?.found).toBe("boolean");
    expect(typeof detectedAgents.body.claude?.found).toBe("boolean");
    expect(["codex", "claude"]).toContain(detectedAgents.body.recommendedBackend);

    const health = await request(app).get("/api/health");
    expect(health.status).toBe(200);
    expect(health.body.service.runOnceInFlight).toBe(false);

    const board = await request(app).get("/api/board");
    expect(board.status).toBe(200);
    expect(board.body.items).toHaveLength(1);
    expect(board.body.items[0].issueUrl).toContain("/issues/7");

    const boardDetail = await request(app).get("/api/board/acme-web/7");
    expect(boardDetail.status).toBe(200);
    expect(boardDetail.body.item.issue.title).toBe("Issue title");
    expect(boardDetail.body.item.discussion).toHaveLength(1);

    const upsert = await request(app).post("/api/repositories").send({
      id: "repo-1",
      localPath: "/tmp/acme-web",
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
    expect(after.body.repositories[0].repo).toBe("web");
    expect(after.body.repositories[0].mediaRepo).toBe("acme/web");
    expect(after.body.repositories[0].mediaBranch).toBe("github-issue-hunter-media");
    expect(after.body.repositories[0].triageWording).toBe(DEFAULT_TRIAGE_WORDING);
    expect(after.body.repositories[0].implementWording).toBe(DEFAULT_IMPLEMENT_WORDING);
    expect(after.body.repositories[0].ignoreWording).toBe(DEFAULT_IGNORE_WORDING);
    expect(after.body.repositories[0].prIssueReferenceMode).toBe("close_keywords");

    const upsertRefsMode = await request(app).post("/api/repositories").send({
      id: "repo-1",
      localPath: "/tmp/acme-web",
      mediaRepo: "acme/shared-media",
      mediaBranch: "custom-media",
      triageCommand: "codex triage --context {context_file}",
      implementCommand: "codex implement --context {context_file}",
      prIssueReferenceMode: "refs",
      enabled: true,
      perRepoConcurrency: 1,
      slack: {
        enabled: true,
        channelId: "C123",
        transport: "chat_sdk"
      }
    });
    expect(upsertRefsMode.status).toBe(200);

    const afterRefsMode = await request(app).get("/api/config");
    expect(afterRefsMode.status).toBe(200);
    expect(afterRefsMode.body.repositories[0].prIssueReferenceMode).toBe("refs");
    expect(afterRefsMode.body.repositories[0].mediaRepo).toBe("acme/shared-media");
    expect(afterRefsMode.body.repositories[0].mediaBranch).toBe("custom-media");

    const auth = await request(app).post("/api/slack/auth-test").send({ botToken: "xoxb-valid-token" });
    expect(auth.status).toBe(200);
    expect(auth.body.ok).toBe(true);

    const channels = await request(app).post("/api/slack/channels").send({ botToken: "xoxb-valid-token" });
    expect(channels.status).toBe(200);
    expect(channels.body.ok).toBe(true);
    expect(channels.body.channels).toHaveLength(2);

    const appInfo = await request(app).post("/api/slack/app-info").send({ botToken: "xoxb-valid-token" });
    expect(appInfo.status).toBe(200);
    expect(appInfo.body.ok).toBe(true);
    expect(appInfo.body.botDisplayName).toBe("acme-bot");

    const detect = await request(app).post("/api/repositories/detect").send({ localPath: "/tmp/acme-web" });
    expect(detect.status).toBe(200);
    expect(detect.body.fullName).toBe("acme/web");

    const slackSave = await request(app).put("/api/slack-app").send({
      enabled: true,
      botToken: "xoxb-valid-token",
      appToken: "xapp-valid-token",
      signingSecret: ""
    });
    expect(slackSave.status).toBe(200);
    expect(slackSave.body.ok).toBe(true);
    expect(slackSave.body.autoFilledAppInfo).toBe(true);

    const afterSlackSave = await request(app).get("/api/config");
    expect(afterSlackSave.status).toBe(200);
    expect(afterSlackSave.body.slackApp.appDisplayName).toBe("acme Issue Hunter");
    expect(afterSlackSave.body.slackApp.botDisplayName).toBe("acme-bot");
  });
});
