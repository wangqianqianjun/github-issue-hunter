# GitHub Issue Hunter

一个面向本地仓库的 GitHub Issue 自动处理系统：
- 24x7 轮询仓库 Open Issue
- 自动 triage（是否需要处理）
- 需要处理时在隔离 `worktree` 中调用 Codex 执行修复
- 自动回写 issue（Summary / RootCause / Solution / PR）
- 可选 Slack 集成（线程内持续跟进）
- 内置 Web UI（Issue Hunter / Board / Slack）

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
  - AI 判断处理 -> 回复 implement wording -> 进入实现
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

1. 打开 UI，先配置全局参数（轮询间隔、并发、工作目录）
2. 在仓库配置中填写本地路径并保存
3. （可选）在 Slack Tab 完成 Bot/App Token 配置并绑定频道
4. 启动 `24x7`，或先点“立即轮询一次”验证流程

## 运行数据目录

- 运行态配置：`state/config.json`
- 运行时数据：`state/runtime/`
- issue 上下文与产物：`artifacts/`

## 安全说明

仓库已通过 `.gitignore` 默认排除敏感与运行态文件（如 Slack/GitHub 凭据、runtime 日志、临时产物），避免误提交。

如果你新增了凭据文件，请同步更新 `.gitignore`。

## 常用命令

```bash
npm test
npm run build
npm run dev
```
# github-issue-hunter
