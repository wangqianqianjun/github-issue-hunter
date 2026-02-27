# GitHub Issue Hunter Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 实现一个可持续运行的 GitHub Issue Hunter，完成 issue 评估、处理、回写、看板与 Slack 通知闭环。

**Architecture:** 使用 Python 单进程守护服务，轮询 GitHub API 发现新 issue；通过 SQLite 做状态持久化；通过外部 Codex 命令完成 triage 与实现；可选 Slack thread 跟进处理进度；完成后回写 issue 并更新本地看板与回归用例。

**Tech Stack:** Python 3.11+, requests, slack-sdk, sqlite3, pytest

---

### Task 1: 项目骨架与配置模型

**Files:**
- Create: `pyproject.toml`
- Create: `README.md`
- Create: `.env.example`
- Create: `github_issue_hunter/config.py`
- Create: `github_issue_hunter/models.py`

**Step 1: Write the failing test**
- 增加配置解析测试（环境变量缺失时报错）。

**Step 2: Run test to verify it fails**
- Run: `pytest -q`
- Expected: FAIL（模块不存在）

**Step 3: Write minimal implementation**
- 实现配置 dataclass 与 TOML + env 覆盖逻辑。

**Step 4: Run test to verify it passes**
- Run: `pytest -q`
- Expected: PASS（配置测试）

### Task 2: GitHub / Slack / Codex 基础客户端

**Files:**
- Create: `github_issue_hunter/github_client.py`
- Create: `github_issue_hunter/slack_client.py`
- Create: `github_issue_hunter/codex_runner.py`
- Create: `tests/test_codex_runner.py`
- Create: `tests/test_markdown_images.py`

**Step 1: Write failing tests**
- Codex JSON 解析失败/成功分支。
- markdown 图片提取结果。

**Step 2: Verify RED**
- Run: `pytest tests/test_codex_runner.py tests/test_markdown_images.py -q`
- Expected: FAIL

**Step 3: Minimal implementation**
- 实现 API 调用、Slack 发消息/线程回复、Codex 命令执行与解析。

**Step 4: Verify GREEN**
- Run: `pytest tests/test_codex_runner.py tests/test_markdown_images.py -q`
- Expected: PASS

### Task 3: 持久化与看板

**Files:**
- Create: `github_issue_hunter/storage.py`
- Create: `github_issue_hunter/board.py`
- Create: `tests/test_board.py`

**Step 1: Write failing test**
- 看板渲染包含已关闭 issue 信息。

**Step 2: Verify RED**
- Run: `pytest tests/test_board.py -q`
- Expected: FAIL

**Step 3: Minimal implementation**
- SQLite schema + 读取 closed issues + markdown board 输出。

**Step 4: Verify GREEN**
- Run: `pytest tests/test_board.py -q`
- Expected: PASS

### Task 4: 主流程编排（issue 生命周期）

**Files:**
- Create: `github_issue_hunter/service.py`
- Create: `github_issue_hunter/prompts.py`
- Create: `github_issue_hunter/cli.py`
- Create: `github_issue_hunter/__main__.py`
- Create: `tests/test_service_flow.py`

**Step 1: Write failing tests**
- 测试 ignored 路径。
- 测试 completed + PR 回写 + close + board 更新路径。

**Step 2: Verify RED**
- Run: `pytest tests/test_service_flow.py -q`
- Expected: FAIL

**Step 3: Minimal implementation**
- 实现轮询、状态机、评论、Slack 线程更新、回归文件生成。

**Step 4: Verify GREEN**
- Run: `pytest tests/test_service_flow.py -q`
- Expected: PASS

### Task 5: 文档与验收

**Files:**
- Modify: `README.md`
- Create: `config.example.toml`

**Step 1: Write docs checklist test (manual)**
- 手动核对 README 是否覆盖配置、启动、Slack、Codex 输出格式。

**Step 2: Full verification**
- Run: `pytest -q`
- Expected: 全部通过

