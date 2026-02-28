import express, { type Request, type Response } from "express";
import { z } from "zod";

import { buildSlackManifest } from "../chat/slack-manifest.js";
import { ConfigStore } from "../core/config-store.js";
import {
  DEFAULT_IGNORE_WORDING,
  DEFAULT_IMPLEMENT_COMMAND,
  DEFAULT_IMPLEMENT_WORDING,
  DEFAULT_TRIAGE_COMMAND,
  DEFAULT_TRIAGE_WORDING
} from "../core/defaults.js";
import type { RepositoryConfig, SlackAppConfig } from "../types/config.js";

interface ServiceStatus {
  running: boolean;
  activeTasks: number;
  queueLength: number;
  lastRunAt: string;
  lastError: string;
}

interface BoardCardResponse {
  issueKey: string;
  repoId: string;
  repoFullName: string;
  issueNumber: number;
  issueUrl: string;
  state:
    | "new"
    | "triaging"
    | "ignored"
    | "awaiting_approval"
    | "scheduled"
    | "implementing"
    | "completed"
    | "failed";
  summary: string;
  rootCause: string;
  solution: string;
  prUrl: string;
  closedAt: string;
  updatedAt: string;
}

interface ApiAppDeps {
  configStore: ConfigStore;
  startService: () => Promise<void>;
  stopService: () => Promise<void>;
  runOnce: () => Promise<void>;
  getServiceStatus: () => Promise<ServiceStatus>;
  listBoardCards?: () => Promise<BoardCardResponse[]>;
  getBoardDetail?: (repoId: string, issueNumber: number) => Promise<unknown | null>;
  slackWebhookHandler?: (request: Request, response: Response) => Promise<void>;
  slackSetup?: {
    authTest: (botToken: string) => Promise<Record<string, unknown>>;
    listChannels: (botToken: string) => Promise<Record<string, unknown>>;
    readAppInfo: (botToken: string) => Promise<Record<string, unknown>>;
  };
  detectRepository?: (localPath: string) => Promise<{ owner: string; repo: string; fullName: string }>;
}

const repositorySchema = z.object({
  id: z.string().min(1).optional(),
  owner: z.string().min(1).optional(),
  repo: z.string().min(1).optional(),
  localPath: z.string().min(1),
  triageCommand: z.string().min(1).optional(),
  implementCommand: z.string().min(1).optional(),
  triageWording: z.string().min(1).optional(),
  implementWording: z.string().min(1).optional(),
  ignoreWording: z.string().min(1).optional(),
  enabled: z.boolean(),
  perRepoConcurrency: z.number().int().min(1),
  slack: z.object({
    enabled: z.boolean(),
    channelId: z.string(),
    transport: z.enum(["none", "slack_sdk", "chat_sdk"])
  })
});

export async function createApiApp(deps: ApiAppDeps) {
  const app = express();

  app.post("/api/webhooks/slack", express.raw({ type: "*/*" }), async (req, res) => {
    if (!deps.slackWebhookHandler) {
      res.status(501).json({ error: "Slack webhook is not configured" });
      return;
    }
    await deps.slackWebhookHandler(req, res);
  });

  app.use(express.json({ limit: "1mb" }));
  app.use(express.static("public"));

  app.get("/api/config", async (_req, res) => {
    const config = await deps.configStore.load();
    res.json(config);
  });

  app.get("/api/board", async (_req, res) => {
    const items = deps.listBoardCards ? await deps.listBoardCards() : [];
    res.json({ items });
  });

  app.get("/api/board/:repoId/:issueNumber", async (req, res) => {
    if (!deps.getBoardDetail) {
      res.status(501).json({ error: "Board detail is not configured" });
      return;
    }

    const repoId = String(req.params.repoId || "").trim();
    const issueNumber = Number(req.params.issueNumber);
    if (!repoId || !Number.isFinite(issueNumber) || issueNumber <= 0) {
      res.status(400).json({ error: "repoId and valid issueNumber are required" });
      return;
    }

    const item = await deps.getBoardDetail(repoId, issueNumber);
    if (!item) {
      res.status(404).json({ error: "Board detail not found" });
      return;
    }

    res.json({ item });
  });

  app.post("/api/repositories", async (req, res) => {
    const parsed = repositorySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.flatten() });
      return;
    }

    let owner = parsed.data.owner?.trim() ?? "";
    let repo = parsed.data.repo?.trim() ?? "";

    if ((!owner || !repo) && deps.detectRepository) {
      const detected = await deps.detectRepository(parsed.data.localPath);
      owner = owner || detected.owner;
      repo = repo || detected.repo;
    }

    if (!owner || !repo) {
      res.status(400).json({ error: "owner/repo missing and detection failed" });
      return;
    }

    const payload: RepositoryConfig = {
      ...(parsed.data as Omit<RepositoryConfig, "id" | "owner" | "repo">),
      id: parsed.data.id?.trim() || `${owner}-${repo}`,
      owner,
      repo,
      triageCommand: parsed.data.triageCommand?.trim() || DEFAULT_TRIAGE_COMMAND,
      implementCommand: parsed.data.implementCommand?.trim() || DEFAULT_IMPLEMENT_COMMAND,
      triageWording: parsed.data.triageWording?.trim() || DEFAULT_TRIAGE_WORDING,
      implementWording: parsed.data.implementWording?.trim() || DEFAULT_IMPLEMENT_WORDING,
      ignoreWording: parsed.data.ignoreWording?.trim() || DEFAULT_IGNORE_WORDING
    };

    await deps.configStore.upsertRepository(payload);
    res.json({ ok: true });
  });

  app.post("/api/repositories/detect", async (req, res) => {
    if (!deps.detectRepository) {
      res.status(501).json({ ok: false, error: "repository detection is not configured" });
      return;
    }
    const localPath = String(req.body?.localPath ?? "").trim();
    if (!localPath) {
      res.status(400).json({ ok: false, error: "localPath is required" });
      return;
    }
    try {
      const detected = await deps.detectRepository(localPath);
      res.json({ ok: true, ...detected });
    } catch (error) {
      res.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.delete("/api/repositories/:id", async (req, res) => {
    await deps.configStore.removeRepository(req.params.id);
    res.json({ ok: true });
  });

  app.put("/api/global", async (req, res) => {
    await deps.configStore.updateGlobal(req.body ?? {});
    res.json({ ok: true });
  });

  app.put("/api/slack-app", async (req, res) => {
    const patch = { ...(req.body ?? {}) } as Partial<SlackAppConfig>;
    let autoFilledAppInfo = false;
    let autoFillError = "";

    const botToken = String(patch.botToken ?? "").trim();
    if (botToken && deps.slackSetup) {
      const appInfo = await deps.slackSetup.readAppInfo(botToken);
      if (appInfo.ok === true) {
        const appDisplayName = typeof appInfo.appDisplayName === "string" ? appInfo.appDisplayName.trim() : "";
        const botDisplayName = typeof appInfo.botDisplayName === "string" ? appInfo.botDisplayName.trim() : "";
        if (appDisplayName) {
          patch.appDisplayName = appDisplayName;
          autoFilledAppInfo = true;
        }
        if (botDisplayName) {
          patch.botDisplayName = botDisplayName;
          autoFilledAppInfo = true;
        }
      } else {
        autoFillError = String(appInfo.error ?? "");
      }
    }

    await deps.configStore.updateSlackApp(patch);
    res.json({
      ok: true,
      autoFilledAppInfo,
      autoFillError
    });
  });

  app.get("/api/slack/manifest", async (_req, res) => {
    const config = await deps.configStore.load();
    const manifest = buildSlackManifest({
      appDisplayName: config.slackApp.appDisplayName,
      botDisplayName: config.slackApp.botDisplayName,
      webhookBaseUrl: config.slackApp.webhookBaseUrl,
      useSocketMode: config.slackApp.useSocketMode
    });
    res.json({ manifest });
  });

  app.post("/api/slack/auth-test", async (req, res) => {
    if (!deps.slackSetup) {
      res.status(501).json({ ok: false, error: "Slack setup service is not configured" });
      return;
    }
    const token = String(req.body?.botToken ?? "");
    const result = await deps.slackSetup.authTest(token);
    res.json(result);
  });

  app.post("/api/slack/channels", async (req, res) => {
    if (!deps.slackSetup) {
      res.status(501).json({ ok: false, error: "Slack setup service is not configured" });
      return;
    }
    const token = String(req.body?.botToken ?? "");
    const result = await deps.slackSetup.listChannels(token);
    res.json(result);
  });

  app.post("/api/slack/app-info", async (req, res) => {
    if (!deps.slackSetup) {
      res.status(501).json({ ok: false, error: "Slack setup service is not configured" });
      return;
    }
    const token = String(req.body?.botToken ?? "");
    const result = await deps.slackSetup.readAppInfo(token);
    res.json(result);
  });

  app.post("/api/service/start", async (_req, res) => {
    await deps.startService();
    res.json({ ok: true });
  });

  app.post("/api/service/stop", async (_req, res) => {
    await deps.stopService();
    res.json({ ok: true });
  });

  app.post("/api/service/run-once", async (_req, res) => {
    await deps.runOnce();
    res.json({ ok: true });
  });

  app.get("/api/service/status", async (_req, res) => {
    res.json(await deps.getServiceStatus());
  });

  return app;
}
