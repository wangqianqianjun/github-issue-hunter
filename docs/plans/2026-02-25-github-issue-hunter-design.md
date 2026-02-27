# GitHub Issue Hunter Design

## 目标
构建一个 24x7 运行的守护进程：持续监听目标仓库新建 open issue，自动评估、分流、触发 Codex 修复、回写 issue 结果、沉淀看板与回归测试资料，并支持 Slack 进度通知。

## 范围与边界
- 范围内：
  - 拉取新 open issue（排除 PR）
  - 首条回复：`正在评估`
  - 拉取 issue 详细上下文（正文、评论、图片 URL、图片文件）
  - 调用 Codex triage agent 判断是否需要处理
  - 不处理时回复：`暂无计划处理。`
  - 需要处理时回复：`已经进入排班计划，正在处理。`
  - 可选 Slack 通知：开始处理时发主消息，并在同 thread 下更新进度
  - 调用 Codex implement agent 处理并提交 PR
  - 在 issue 下回写 `summary / rootcause / solution / PR`
  - 可配置自动 close issue
  - 将关闭 issue 沉淀到本项目看板
  - 为每个完成 issue 生成回归用例记录模板
- 范围外（MVP 不做）：
  - 复杂优先级排班算法（只做 FIFO）
  - 并行多 issue worker 池（先单 worker，保证确定性）
  - Slack 富交互 Block Kit 工作流（先文本线程）

## 核心架构
- `HunterService`：主循环，按轮询周期拉取 issue 并驱动状态机。
- `GitHubClient`：封装 REST API（list/get/comment/close/comment list）。
- `CodexRunner`：执行外部 Codex 命令，统一 prompt 产出和 JSON 结果解析。
- `SlackNotifier`：封装 Slack 消息发送与 thread 更新（可选启用）。
- `Storage`：SQLite 持久化 issue 状态、结果、thread_ts。
- `BoardWriter`：从 SQLite 渲染 `reports/closed-issues-board.md`。
- `RegressionCaseWriter`：按 issue 产出 `regression_cases/issue-<n>.md`。

## 状态机
- `new` -> `triaging` -> `ignored`（不处理）
- `new` -> `triaging` -> `scheduled` -> `implementing` -> `completed`
- 任意中间态异常 -> `failed`

## 数据流
1. 轮询 GitHub open issues。
2. 对“未见过”的 issue 创建本地记录并回复 `正在评估`。
3. 收集 issue 上下文（含图片 URL 提取与下载）。
4. 运行 triage agent，读取 JSON：`needs_processing`。
5. 若否：回复 `暂无计划处理。`，状态置 `ignored`。
6. 若是：回复 `已经进入排班计划，正在处理。`，Slack 发起 thread。
7. 运行 implement agent，要求输出：`summary/root_cause/solution/pr_url/test_cases`。
8. 回写 issue 评论；若配置开启则 close issue。
9. 更新看板文件与回归用例模板。

## 关键配置
- GitHub：`token / owner / repo / api_base`
- 轮询：`interval_seconds`
- Codex：`triage_command / implement_command / working_dir`
- 目标仓库：`local_path`
- Slack：`enabled / bot_token / channel_id`
- 策略：`close_issue_on_done`

## 失败处理
- 单 issue 流程出错：记录 `failed`，写入运行日志；不中断主循环。
- 外部命令返回非法 JSON：标记失败并在 Slack thread 报错。
- GitHub API 非 2xx：抛出异常并记录；下一轮重试其他 issue。

## 测试策略
- 单元测试：
  - markdown 图片提取
  - Codex JSON 解析
  - 看板渲染
  - issue 流程分支（ignored / completed）
- 集成测试：
  - 使用 fake GitHub/Fake Codex/Fake Slack 走完整状态流

## 安全与可运维
- 所有 token 通过环境变量注入。
- 日志不打印敏感 token。
- 单进程单 worker，避免重复处理同 issue。
- 支持 `--once` 模式便于 cron/调试。
