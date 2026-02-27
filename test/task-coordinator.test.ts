import { describe, expect, it } from "vitest";

import { TaskCoordinator } from "../src/core/task-coordinator.js";

describe("TaskCoordinator", () => {
  it("prevents duplicate issue execution for same repository", () => {
    const coordinator = new TaskCoordinator();

    expect(coordinator.tryAcquire("acme/web#42")).toBe(true);
    expect(coordinator.tryAcquire("acme/web#42")).toBe(false);

    coordinator.release("acme/web#42");
    expect(coordinator.tryAcquire("acme/web#42")).toBe(true);
  });

  it("tracks independent issue keys independently", () => {
    const coordinator = new TaskCoordinator();

    expect(coordinator.tryAcquire("acme/web#42")).toBe(true);
    expect(coordinator.tryAcquire("acme/api#42")).toBe(true);
    expect(coordinator.activeCount()).toBe(2);
  });
});
