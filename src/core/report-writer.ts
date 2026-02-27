import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { IssueExecutionRecord, RepositoryConfig } from "../types/config.js";

export async function writeBoard(boardFile: string, records: IssueExecutionRecord[]): Promise<void> {
  await mkdir(dirname(boardFile), { recursive: true });

  const lines = [
    "# Closed Issues Board",
    "",
    "| Repository | Issue | Summary | RootCause | Solution | PR | ClosedAt |",
    "| --- | --- | --- | --- | --- | --- | --- |"
  ];

  for (const record of records) {
    lines.push(
      `| ${escapeCell(record.repoId)} | #${record.issueNumber} | ${escapeCell(record.summary)} | ${escapeCell(record.rootCause)} | ${escapeCell(record.solution)} | ${escapeCell(record.prUrl)} | ${escapeCell(record.closedAt)} |`
    );
  }

  await writeFile(boardFile, `${lines.join("\n")}\n`, "utf8");
}

export async function writeRegressionCase(
  baseDir: string,
  repo: RepositoryConfig,
  issueNumber: number,
  issueTitle: string,
  payload: Record<string, unknown>
): Promise<void> {
  await mkdir(baseDir, { recursive: true });

  const file = join(baseDir, `${repo.id}-issue-${issueNumber}.md`);
  const testCases = Array.isArray(payload.test_cases) ? payload.test_cases : [];

  const lines = [
    `# Regression Case - ${repo.owner}/${repo.repo}#${issueNumber}`,
    "",
    `Title: ${issueTitle}`,
    "",
    "## Summary",
    String(payload.summary ?? ""),
    "",
    "## RootCause",
    String(payload.root_cause ?? payload.rootCause ?? ""),
    "",
    "## Solution",
    String(payload.solution ?? ""),
    "",
    "## PR",
    String(payload.pr_url ?? payload.prUrl ?? ""),
    "",
    "## Test Cases"
  ];

  if (!testCases.length) {
    lines.push("- No test cases returned by implementation agent");
  } else {
    for (const item of testCases) {
      const entry = item as Record<string, unknown>;
      lines.push(`- ${String(entry.name ?? "unnamed")}: ${String(entry.path ?? "")}`);
    }
  }

  await writeFile(file, `${lines.join("\n")}\n`, "utf8");
}

function escapeCell(input: string): string {
  return String(input || "-").replaceAll("|", "\\|").replaceAll("\n", " ");
}
