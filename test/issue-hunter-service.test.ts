import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigStore } from "../src/core/config-store.js";
import { IssueHunterService } from "../src/core/issue-hunter-service.js";

class StartTrackingService extends IssueHunterService {
  starts = 0;

  override async start(): Promise<void> {
    this.starts += 1;
  }
}

describe("IssueHunterService resumeFromServiceState", () => {
  it("auto resumes when persisted running flag is true", async () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-hunter-service-"));
    const store = new ConfigStore(join(dir, "config.json"));
    await store.load();
    await store.updateServiceState({ running: true });

    const service = new StartTrackingService(store);
    const resumed = await service.resumeFromServiceState();

    expect(resumed).toBe(true);
    expect(service.starts).toBe(1);
  });

  it("does not auto resume when persisted running flag is false", async () => {
    const dir = mkdtempSync(join(tmpdir(), "issue-hunter-service-"));
    const store = new ConfigStore(join(dir, "config.json"));
    await store.load();
    await store.updateServiceState({ running: false });

    const service = new StartTrackingService(store);
    const resumed = await service.resumeFromServiceState();

    expect(resumed).toBe(false);
    expect(service.starts).toBe(0);
  });
});
