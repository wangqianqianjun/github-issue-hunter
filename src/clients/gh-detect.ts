import { runCommand } from "../utils/run-command.js";

export async function detectRepositoryFromLocalPath(localPath: string): Promise<{ owner: string; repo: string; fullName: string }> {
  let result;
  try {
    result = await runCommand("gh", ["repo", "view", "--json", "nameWithOwner"], { cwd: localPath });
  } catch (error) {
    throw new Error(
      `Failed to run gh command. Ensure GitHub CLI is installed and available in PATH. Original error: ${String(error)}`
    );
  }

  if (result.code !== 0) {
    throw new Error(`gh repo view failed: ${result.stderr || result.stdout}. Run 'gh auth status' in this directory.`);
  }

  const payload = JSON.parse(result.stdout) as { nameWithOwner?: string };
  const fullName = String(payload.nameWithOwner ?? "").trim();
  if (!fullName || !fullName.includes("/")) {
    throw new Error(`Unable to detect owner/repo from ${localPath}`);
  }

  const [owner, repo] = fullName.split("/");
  return { owner, repo, fullName };
}
