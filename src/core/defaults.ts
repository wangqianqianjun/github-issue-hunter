export const DEFAULT_TRIAGE_COMMAND =
  'codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "{worktree}" {resume_clause} "Read the issue context JSON file at {context_file}. You MUST inspect relevant code files and tests in the current repository before deciding. Use the current repository code as source of truth. You may use any tools/skills needed. You are the stage router for this issue conversation. Decide the next stage. Output must be human-readable Chinese only, exactly three lines: 第一行: 决策: 是 或 决策: 否; 第二行: 原因: <一句话>; 第三行: 下一步: implement 或 design 或 update 或 confirm 或 ignore. 含义: implement=直接进入实现; design/update=生成或更新设计方案并等待确认; confirm=等待用户进一步确认; ignore=当前不处理. Do not output any other sections."';
export const DEFAULT_IMPLEMENT_COMMAND =
  'codex exec --json --dangerously-bypass-approvals-and-sandbox --skip-git-repo-check --cd "{worktree}" {resume_clause} {implement_user_message}';

export const DEFAULT_TRIAGE_WORDING = "已经收到，正在分析";
export const DEFAULT_IMPLEMENT_WORDING = "已经确认，正在处理";
export const DEFAULT_IGNORE_WORDING = "已经确认，目前没有计划支持";
