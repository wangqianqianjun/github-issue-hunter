import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { IssueExecutionRecord } from "../types/config.js";
import type { RuntimeStore } from "./issue-engine.js";

interface RuntimeStateFile {
  seenIssueKeys: string[];
  records: IssueExecutionRecord[];
}

const DEFAULT_STATE: RuntimeStateFile = {
  seenIssueKeys: [],
  records: []
};

export class FileRuntimeStore implements RuntimeStore {
  constructor(private readonly filePath: string) {}

  async isSeen(issueKey: string): Promise<boolean> {
    const data = await this.load();
    return data.seenIssueKeys.includes(issueKey);
  }

  async getRecord(issueKey: string): Promise<IssueExecutionRecord | null> {
    const data = await this.load();
    return data.records.find((item) => item.issueKey === issueKey) ?? null;
  }

  async markSeen(issueKey: string): Promise<void> {
    await this.mutate(async (data) => {
      if (data.seenIssueKeys.includes(issueKey)) {
        return false;
      }
      data.seenIssueKeys.push(issueKey);
      return true;
    });
  }

  async saveRecord(record: IssueExecutionRecord): Promise<void> {
    await this.mutate(async (data) => {
      const idx = data.records.findIndex((item) => item.issueKey === record.issueKey);
      if (idx >= 0) {
        data.records[idx] = record;
      } else {
        data.records.push(record);
      }
      return true;
    });
  }

  async listCompleted(): Promise<IssueExecutionRecord[]> {
    const data = await this.load();
    return data.records.filter((item) => item.state === "completed");
  }

  async listAll(): Promise<IssueExecutionRecord[]> {
    const data = await this.load();
    return data.records;
  }

  private async load(): Promise<RuntimeStateFile> {
    return this.loadUnsafe();
  }

  private async loadUnsafe(): Promise<RuntimeStateFile> {
    try {
      const text = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(text) as RuntimeStateFile;
      return {
        seenIssueKeys: Array.isArray(parsed.seenIssueKeys) ? parsed.seenIssueKeys : [],
        records: Array.isArray(parsed.records) ? parsed.records : []
      };
    } catch {
      return structuredClone(DEFAULT_STATE);
    }
  }

  private async saveUnsafe(data: RuntimeStateFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempFilePath = `${this.filePath}.tmp.${process.pid}.${Date.now()}`;
    await writeFile(tempFilePath, JSON.stringify(data, null, 2), "utf8");
    await rename(tempFilePath, this.filePath);
  }

  private async mutate(mutator: (data: RuntimeStateFile) => Promise<boolean> | boolean): Promise<void> {
    await withFileLock(this.filePath, async () => {
      const data = await this.loadUnsafe();
      const changed = await mutator(data);
      if (!changed) {
        return;
      }
      await this.saveUnsafe(data);
    });
  }
}

async function withFileLock<T>(targetFilePath: string, task: () => Promise<T>): Promise<T> {
  const lockPath = `${targetFilePath}.lock`;
  const timeoutMs = Math.max(1000, Number(process.env.ISSUE_HUNTER_RUNTIME_LOCK_TIMEOUT_MS || 10000));
  const retryMs = Math.max(10, Number(process.env.ISSUE_HUNTER_RUNTIME_LOCK_RETRY_MS || 40));
  const staleMs = Math.max(1000, Number(process.env.ISSUE_HUNTER_RUNTIME_LOCK_STALE_MS || 120000));
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      await mkdir(dirname(targetFilePath), { recursive: true });
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(`${process.pid}:${Date.now()}`);
      } catch {
        // Lock metadata is best effort.
      }

      try {
        return await task();
      } finally {
        try {
          await handle.close();
        } catch {
          // Ignore close failures while releasing lock.
        }
        await rm(lockPath, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      const code = (error as { code?: string })?.code;
      if (code !== "EEXIST") {
        throw error;
      }

      const now = Date.now();
      if (now > deadline) {
        throw new Error(`Runtime store lock timeout for ${targetFilePath}`);
      }

      // Best-effort stale lock eviction after owner crash.
      try {
        const lockStat = await stat(lockPath);
        if (now - lockStat.mtimeMs > staleMs) {
          await rm(lockPath, { force: true });
          continue;
        }
      } catch {
        // Ignore races where lock file disappears between stat/remove.
      }

      await sleep(retryMs);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
