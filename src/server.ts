import "dotenv/config";

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createApiApp } from "./api/app.js";
import { ConfigStore } from "./core/config-store.js";
import { IssueHunterService } from "./core/issue-hunter-service.js";
import { SlackSetupService } from "./chat/slack-setup-service.js";
import { detectRepositoryFromLocalPath } from "./clients/gh-detect.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function main() {
  const rootDir = resolve(__dirname, "..");
  const configPath = process.env.ISSUE_HUNTER_CONFIG_PATH || resolve(rootDir, "state", "config.json");
  const port = Number(process.env.PORT || 8787);
  const host = process.env.HOST || "127.0.0.1";

  const configStore = new ConfigStore(configPath);
  const service = new IssueHunterService(configStore);
  await service.initializeRealtimeIntegrations();
  const slackSetup = new SlackSetupService(async () => {
    const config = await configStore.load();
    const direct = config.slackApp.botToken?.trim();
    if (direct) {
      return direct;
    }
    return process.env[config.slackApp.botTokenEnv] ?? "";
  });

  const app = await createApiApp({
    configStore,
    startService: async () => service.start(),
    stopService: async () => service.stop(),
    runOnce: async () => service.runOnce(),
    getServiceStatus: async () => service.getStatus(),
    listBoardCards: async () => service.listBoardCards(),
    getBoardDetail: async (repoId, issueNumber) => service.getBoardDetail(repoId, issueNumber),
    slackWebhookHandler: async (req, res) => service.handleSlackWebhook(req, res),
    detectRepository: async (localPath) => detectRepositoryFromLocalPath(localPath),
    slackSetup: {
      authTest: async (botToken) => slackSetup.authTest(botToken),
      listChannels: async (botToken) => slackSetup.listChannels(botToken),
      readAppInfo: async (botToken) => slackSetup.readAppInfo(botToken)
    }
  });

  app.listen(port, host, () => {
    // eslint-disable-next-line no-console
    console.log(`Issue Hunter UI running at http://${host}:${port}`);
  });
}

void main();
