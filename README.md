# GitHub Issue Hunter

一个面向本地仓库的 GitHub Issue 自动处理系统：
- 24x7 轮询仓库 Open Issue
- 自动 triage（是否需要处理）
- 需要处理时在隔离 `worktree` 中调用 Codex 执行修复
- 自动回写 issue（Summary / RootCause / Solution / PR）
- 可选 Slack 集成（线程内持续跟进）
- 内置 Web UI（Issue Hunter / Board / Slack）

## 最新特性（新增）

- Plan 模式（默认开启）
  - 当 triage 判断“需要处理”时，先输出详细设计与实现方案并回写到 issue
  - 系统进入 `awaiting_approval` 状态，等待用户 approve
  - 只有收到 approve 后，才进入实际实现阶段
- 审批驱动实现
  - 支持在 issue 评论中使用 `approve / approved / 同意 / 通过 / lgtm / go ahead` 等指令触发实现
  - Board 中会展示“处理中（含 awaiting_approval）”与“已完成”
- Slack 消息批量合并
  - 线程进度更新会按时间窗口聚合，减少刷屏
  - 默认每 45 秒发送一批（可通过环境变量调整）
- Context 文件不再写入仓库
  - issue 的 `context.json` 统一写入工作目录下的 `artifacts`，避免误提交到业务仓库

## 界面预览

### 1) 主界面与服务控制
![主界面与服务控制](./1.png)

### 2) 仓库配置（工作目录、wording、并发）
![仓库配置](./2.png)

### 3) Issue Board（处理中 / 已完成）
![Issue Board](./3.png)

## 核心能力

- 多仓库管理
  - 配置本地仓库路径后，自动识别 `owner/repo`
  - 每仓库独立并发控制
- 自动处理流程
  - 发现新 issue -> 回复 triage wording
  - AI 判断不处理 -> 回复 ignore wording
  - AI 判断处理
    - Plan 模式开启：先回复 implement wording + 设计方案，等待 approve 后实现
    - Plan 模式关闭：直接回复 implement wording 并进入实现
- 隔离执行
  - 所有代码修改都在 `git worktree` 中完成，避免互相污染
- PR 与回写
  - 处理完成后回写 `Summary / RootCause / Solution / PR`
- 看板追踪
  - UI 卡片化展示处理中与已完成 issue
  - 支持查看原始问题、讨论过程、解决方案与 PR 链接
- Slack（可选）
  - 绑定 channel 后，在同一 thread 内同步进度
  - 支持 Socket Mode
  - 线程消息批量聚合，默认降低高频推送

## 技术栈

- Node.js + TypeScript
- Express
- GitHub CLI (`gh`)
- Slack SDK / Chat SDK

## 前置要求

1. Node.js 18+
2. Git
3. GitHub CLI（已登录）

```bash
gh auth status
# 若未登录
gh auth login
```

## 启动

```bash
npm install
npm run dev
```

默认地址：`http://127.0.0.1:8787`

## 基本使用

1. 打开 UI，先配置全局参数（轮询间隔、并发、工作目录、Plan 模式）
2. 在仓库配置中填写本地路径并保存
3. （可选）在 Slack Tab 完成 Bot/App Token 配置并绑定频道
4. 启动 `24x7`，或先点“立即轮询一次”验证流程

## 运行数据目录

- 运行态配置：`state/config.json`
- 运行时数据：`state/runtime/`
- issue 上下文与产物：`<工作目录>/artifacts/`
  - 示例：`<工作目录>/artifacts/<repoId>/issue-180/context.json`
  - 不会再写入业务仓库的 `.issue-hunter/` 目录

## 安全说明

仓库已通过 `.gitignore` 默认排除敏感与运行态文件（如 Slack/GitHub 凭据、runtime 日志、临时产物），避免误提交。

如果你新增了凭据文件，请同步更新 `.gitignore`。

## 常用命令

```bash
npm test
npm run build
npm run dev
```
