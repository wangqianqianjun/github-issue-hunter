export class TaskCoordinator {
  private readonly active = new Set<string>();

  tryAcquire(issueKey: string): boolean {
    if (this.active.has(issueKey)) {
      return false;
    }
    this.active.add(issueKey);
    return true;
  }

  release(issueKey: string): void {
    this.active.delete(issueKey);
  }

  activeCount(): number {
    return this.active.size;
  }
}
