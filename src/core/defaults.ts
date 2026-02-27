export const DEFAULT_TRIAGE_COMMAND =
  'codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "{worktree}" {resume_clause} "Read the issue context JSON file at {context_file}. You MUST inspect relevant code files and tests in the current repository before deciding. Use the current repository code as source of truth. You may use any tools/skills needed. Decide whether this issue should continue into engineering implementation right now. Output must be human-readable Chinese only, exactly two lines: 第一行: 决策: 是 或 决策: 否; 第二行: 原因: <一句话>. Do not output any other sections."';
export const DEFAULT_IMPLEMENT_COMMAND =
  'codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "{worktree}" {resume_clause} {implement_user_message}';

export const DEFAULT_TRIAGE_WORDING = "已经收到，正在分析";
export const DEFAULT_IMPLEMENT_WORDING = "已经确认，正在处理";
export const DEFAULT_IGNORE_WORDING = "已经确认，目前没有计划支持";
