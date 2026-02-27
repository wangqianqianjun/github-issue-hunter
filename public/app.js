const state = {
  config: null,
  status: null,
  slackChannels: [],
  slackChannelsLoadedToken: "",
  boardItems: [],
  activeBoardItem: null,
  activeBoardRequestId: 0
};

const DEFAULT_TRIAGE_COMMAND = "codex triage --context {context_file}";
const DEFAULT_IMPLEMENT_COMMAND = "codex implement --context {context_file}";
const DEFAULT_TRIAGE_WORDING = "已经收到，正在分析";
const DEFAULT_IMPLEMENT_WORDING = "已经确认，正在处理";
const DEFAULT_IGNORE_WORDING = "已经确认，目前没有计划支持";

const els = {
  globalForm: document.getElementById("global-form"),
  slackForm: document.getElementById("slack-form"),
  repoForm: document.getElementById("repo-form"),
  repoTableBody: document.querySelector("#repo-table tbody"),
  bindingTableBody: document.querySelector("#binding-table tbody"),
  channelTableBody: document.querySelector("#slack-channel-table tbody"),
  channelCount: document.getElementById("channel-count"),
  channelStatus: document.getElementById("channel-status"),
  statusBadge: document.getElementById("service-status"),
  statusJson: document.getElementById("service-status-json"),
  manifestOutput: document.getElementById("manifest-output"),
  slackAuthResult: document.getElementById("slack-auth-result"),
  slackAppNameView: document.getElementById("slack-app-name-view"),
  webhookBaseUrlHint: document.getElementById("webhook-base-url-hint"),
  boardCount: document.getElementById("board-count"),
  boardProcessingCount: document.getElementById("board-processing-count"),
  boardCompletedCount: document.getElementById("board-completed-count"),
  boardProcessingEmpty: document.getElementById("board-processing-empty"),
  boardCompletedEmpty: document.getElementById("board-completed-empty"),
  boardProcessingCards: document.getElementById("board-processing-cards"),
  boardCompletedCards: document.getElementById("board-completed-cards"),
  boardRefresh: document.getElementById("btn-refresh-board"),
  boardModal: document.getElementById("board-detail-modal"),
  boardClose: document.getElementById("board-detail-close"),
  boardTitle: document.getElementById("board-detail-title"),
  boardMeta: document.getElementById("board-detail-meta"),
  boardIssueLink: document.getElementById("board-detail-issue-link"),
  boardPrLink: document.getElementById("board-detail-pr-link"),
  boardIssueTitle: document.getElementById("board-detail-issue-title"),
  boardIssueBody: document.getElementById("board-detail-issue-body"),
  boardDiscussion: document.getElementById("board-detail-discussion"),
  boardSummary: document.getElementById("board-detail-summary"),
  boardRootCause: document.getElementById("board-detail-root-cause"),
  boardSolution: document.getElementById("board-detail-solution"),
  tabButtons: Array.from(document.querySelectorAll(".tab-btn")),
  tabContents: Array.from(document.querySelectorAll(".tab-content"))
};

init().catch((error) => {
  // eslint-disable-next-line no-alert
  alert(`初始化失败: ${error.message}`);
});

async function init() {
  bindEvents();
  await refreshAll();
}

function bindEvents() {
  bindTabEvents();

  document.getElementById("btn-start").addEventListener("click", () => callServiceAction("start"));
  document.getElementById("btn-stop").addEventListener("click", () => callServiceAction("stop"));
  document.getElementById("btn-run-once").addEventListener("click", () => callServiceAction("run-once"));
  document.getElementById("btn-refresh").addEventListener("click", () => refreshAll());
  els.boardRefresh.addEventListener("click", () => loadBoard());

  document.getElementById("btn-manifest").addEventListener("click", () => loadManifest());
  document.getElementById("btn-copy-manifest").addEventListener("click", () => copyManifest());
  document.getElementById("btn-open-slack").addEventListener("click", () => openSlackCreateApp());
  document.getElementById("btn-auth-test").addEventListener("click", () => runSlackAuthTest());
  document.getElementById("btn-load-channels").addEventListener("click", () => loadSlackChannels());
  document.getElementById("btn-detect-repo").addEventListener("click", () => detectRepoAndFill());
  document.getElementById("btn-reset-repo").addEventListener("click", () => resetRepoForm());
  els.boardClose.addEventListener("click", () => closeBoardDetail());
  els.boardModal.addEventListener("click", (event) => {
    if (event.target === els.boardModal) {
      closeBoardDetail();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeBoardDetail();
    }
  });

  const socketModeInput = els.slackForm.elements.namedItem("useSocketMode");
  if (socketModeInput) {
    socketModeInput.addEventListener("change", () => updateWebhookBaseUrlHint());
  }

  els.globalForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(els.globalForm);
    await jsonFetch("/api/global", {
      method: "PUT",
      body: {
        pollIntervalSeconds: Number(form.get("pollIntervalSeconds")),
        globalConcurrency: Number(form.get("globalConcurrency")),
        workspaceDir: String(form.get("workspaceDir") || ""),
        closeIssueOnDone: Boolean(form.get("closeIssueOnDone")),
        keepWorktrees: Boolean(form.get("keepWorktrees"))
      }
    });
    await refreshAll();
  });

  els.slackForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(els.slackForm);
    const result = await jsonFetch("/api/slack-app", {
      method: "PUT",
      body: {
        enabled: Boolean(form.get("enabled")),
        botToken: String(form.get("botToken") || ""),
        appToken: String(form.get("appToken") || ""),
        signingSecret: String(form.get("signingSecret") || ""),
        clientId: String(form.get("clientId") || ""),
        clientSecret: String(form.get("clientSecret") || ""),
        webhookBaseUrl: String(form.get("webhookBaseUrl") || ""),
        useSocketMode: Boolean(form.get("useSocketMode"))
      }
    });

    await refreshAll();
    if (result.autoFilledAppInfo) {
      alert("Slack 配置已保存，并自动更新了 App/Bot 名称");
      return;
    }
    if (result.autoFillError) {
      alert(`Slack 配置已保存，但自动读取 App/Bot 名称失败: ${result.autoFillError}`);
      return;
    }
    alert("Slack 配置已保存");
  });

  els.repoForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = new FormData(els.repoForm);
    const localPath = String(form.get("localPath") || "").trim();
    const detected = await detectRepository(localPath);
    setInput(els.repoForm, "detectedRepo", detected.fullName);

    const owner = detected.owner;
    const repo = detected.repo;
    const id = String(form.get("id") || "").trim() || `${owner}-${repo}`;
    const existing = (state.config?.repositories || []).find((item) => item.id === id);
    const slack = existing?.slack ?? {
      enabled: false,
      channelId: "",
      transport: "none"
    };
    const triageCommand = String(existing?.triageCommand || DEFAULT_TRIAGE_COMMAND);
    const implementCommand = String(existing?.implementCommand || DEFAULT_IMPLEMENT_COMMAND);

    await saveRepository({
      id,
      owner,
      repo,
      localPath,
      triageCommand,
      implementCommand,
      triageWording: String(form.get("triageWording") || DEFAULT_TRIAGE_WORDING),
      implementWording: String(form.get("implementWording") || DEFAULT_IMPLEMENT_WORDING),
      ignoreWording: String(form.get("ignoreWording") || DEFAULT_IGNORE_WORDING),
      enabled: Boolean(form.get("enabled")),
      perRepoConcurrency: Number(form.get("perRepoConcurrency") || 1),
      slack
    });

    resetRepoForm();
    await refreshAll();
  });
}

async function refreshAll() {
  await Promise.all([loadConfig(), loadStatus(), loadBoard()]);
}

async function loadConfig() {
  state.config = await jsonFetch("/api/config");
  fillGlobalForm();
  fillSlackForm();
  await autoLoadSlackChannels();
  renderRepoTable();
  renderBindingTable();
}

async function loadStatus() {
  state.status = await jsonFetch("/api/service/status");
  els.statusBadge.textContent = state.status.running ? "running" : "stopped";
  els.statusBadge.style.background = state.status.running ? "#86efac" : "#e2e8f0";
  els.statusJson.textContent = JSON.stringify(state.status, null, 2);
}

async function loadBoard() {
  const data = await jsonFetch("/api/board");
  state.boardItems = Array.isArray(data.items) ? data.items : [];
  renderBoardCards();
}

function fillGlobalForm() {
  const global = state.config.global;
  setInput(els.globalForm, "pollIntervalSeconds", global.pollIntervalSeconds);
  setInput(els.globalForm, "globalConcurrency", global.globalConcurrency);
  setInput(els.globalForm, "workspaceDir", global.workspaceDir);
  setCheckbox(els.globalForm, "closeIssueOnDone", global.closeIssueOnDone);
  setCheckbox(els.globalForm, "keepWorktrees", global.keepWorktrees);
}

function fillSlackForm() {
  const slack = state.config.slackApp;
  setCheckbox(els.slackForm, "enabled", slack.enabled);
  setInput(els.slackForm, "botToken", slack.botToken || "");
  setInput(els.slackForm, "appToken", slack.appToken || "");
  setInput(els.slackForm, "signingSecret", slack.signingSecret || "");
  setInput(els.slackForm, "clientId", slack.clientId || "");
  setInput(els.slackForm, "clientSecret", slack.clientSecret || "");
  setInput(els.slackForm, "webhookBaseUrl", slack.webhookBaseUrl);
  setCheckbox(els.slackForm, "useSocketMode", slack.useSocketMode);
  updateWebhookBaseUrlHint();
  if (els.slackAppNameView) {
    els.slackAppNameView.textContent = `当前 App/Bot 名称：${slack.appDisplayName || "-"} / ${slack.botDisplayName || "-"}`;
  }
}

function renderRepoTable() {
  const rows = state.config.repositories || [];
  els.repoTableBody.innerHTML = "";

  rows.forEach((repo) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(repo.id)}</td>
      <td>${escapeHtml(repo.owner)}/${escapeHtml(repo.repo)}</td>
      <td>${escapeHtml(repo.localPath)}</td>
      <td>${escapeHtml(formatSlackBinding(repo))}</td>
      <td>${repo.enabled ? "enabled" : "disabled"}</td>
      <td>
        <button data-action="edit" data-id="${escapeHtml(repo.id)}" class="ghost">编辑</button>
        <button data-action="delete" data-id="${escapeHtml(repo.id)}" class="danger">删除</button>
      </td>
    `;

    tr.querySelector('[data-action="edit"]').addEventListener("click", () => fillRepoForm(repo));
    tr.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      if (!confirm(`确认删除仓库 ${repo.id} ?`)) {
        return;
      }
      await jsonFetch(`/api/repositories/${repo.id}`, { method: "DELETE" });
      await refreshAll();
    });

    els.repoTableBody.appendChild(tr);
  });
}

function renderBindingTable() {
  const repos = state.config.repositories || [];
  els.bindingTableBody.innerHTML = "";

  repos.forEach((repo) => {
    const tr = document.createElement("tr");
    const channelSelect = buildChannelSelect(repo.slack.channelId || "");
    const transportSelect = document.createElement("select");
    ["none", "slack_sdk", "chat_sdk"].forEach((transport) => {
      const option = document.createElement("option");
      option.value = transport;
      option.textContent = transport;
      if (repo.slack.transport === transport) {
        option.selected = true;
      }
      transportSelect.appendChild(option);
    });

    const notifyCheckbox = document.createElement("input");
    notifyCheckbox.type = "checkbox";
    notifyCheckbox.checked = Boolean(repo.slack.enabled);

    const saveButton = document.createElement("button");
    saveButton.className = "ghost";
    saveButton.textContent = "保存绑定";
    saveButton.addEventListener("click", async () => {
      const updated = {
        ...repo,
        slack: {
          enabled: notifyCheckbox.checked,
          channelId: channelSelect.value,
          transport: transportSelect.value
        }
      };
      await saveRepository(updated);
      await refreshAll();
    });

    tr.appendChild(td(`${repo.owner}/${repo.repo}`));
    tr.appendChild(tdNode(channelSelect));
    tr.appendChild(tdNode(transportSelect));
    tr.appendChild(tdNode(notifyCheckbox));
    tr.appendChild(tdNode(saveButton));
    els.bindingTableBody.appendChild(tr);
  });
}

function buildChannelSelect(selectedValue) {
  const select = document.createElement("select");
  const empty = document.createElement("option");
  empty.value = "";
  empty.textContent = "未选择";
  select.appendChild(empty);

  for (const channel of state.slackChannels) {
    const option = document.createElement("option");
    option.value = channel.id;
    option.textContent = `${channel.name} (${channel.id})`;
    if (channel.id === selectedValue) {
      option.selected = true;
    }
    select.appendChild(option);
  }

  return select;
}

function fillRepoForm(repo) {
  setInput(els.repoForm, "id", repo.id);
  setInput(els.repoForm, "detectedRepo", `${repo.owner}/${repo.repo}`);
  setInput(els.repoForm, "localPath", repo.localPath);
  setInput(els.repoForm, "triageWording", repo.triageWording || DEFAULT_TRIAGE_WORDING);
  setInput(els.repoForm, "implementWording", repo.implementWording || DEFAULT_IMPLEMENT_WORDING);
  setInput(els.repoForm, "ignoreWording", repo.ignoreWording || DEFAULT_IGNORE_WORDING);
  setInput(els.repoForm, "perRepoConcurrency", repo.perRepoConcurrency);
  setCheckbox(els.repoForm, "enabled", repo.enabled);
}

function resetRepoForm() {
  els.repoForm.reset();
  setInput(els.repoForm, "id", "");
  setInput(els.repoForm, "detectedRepo", "");
  setInput(els.repoForm, "triageWording", DEFAULT_TRIAGE_WORDING);
  setInput(els.repoForm, "implementWording", DEFAULT_IMPLEMENT_WORDING);
  setInput(els.repoForm, "ignoreWording", DEFAULT_IGNORE_WORDING);
  setInput(els.repoForm, "perRepoConcurrency", 1);
}

async function callServiceAction(action) {
  await jsonFetch(`/api/service/${action}`, { method: "POST" });
  await loadStatus();
}

async function loadManifest() {
  const data = await jsonFetch("/api/slack/manifest");
  state.lastManifest = data.manifest;
  els.manifestOutput.value = JSON.stringify(data.manifest, null, 2);
}

async function copyManifest() {
  if (!els.manifestOutput.value) {
    await loadManifest();
  }
  await navigator.clipboard.writeText(els.manifestOutput.value);
  alert("Manifest 已复制");
}

function openSlackCreateApp() {
  let manifest = els.manifestOutput.value;
  if (!manifest.trim()) {
    manifest = JSON.stringify(state.lastManifest || {}, null, 2);
  }

  if (!manifest.trim()) {
    alert("请先生成 Manifest");
    return;
  }

  try {
    const compact = JSON.stringify(JSON.parse(manifest));
    const url = `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(compact)}`;
    window.open(url, "_blank");
  } catch {
    alert("Manifest 格式错误，请先重新生成 Manifest");
  }
}

async function runSlackAuthTest() {
  const token = String(els.slackForm.elements.namedItem("botToken")?.value || "").trim();
  const result = await jsonFetch("/api/slack/auth-test", {
    method: "POST",
    body: {
      botToken: token
    }
  });
  els.slackAuthResult.textContent = JSON.stringify(result, null, 2);
}

async function loadSlackChannels() {
  setChannelStatus("正在刷新频道列表...");
  try {
    await loadSlackChannelsInternal({
      silent: false,
      force: true
    });
  } catch (error) {
    alert(`刷新频道列表失败: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function autoLoadSlackChannels() {
  await loadSlackChannelsInternal({
    silent: true,
    force: false
  });
}

async function loadSlackChannelsInternal(options) {
  const token = readSlackBotToken();
  if (!token) {
    state.slackChannels = [];
    state.slackChannelsLoadedToken = "";
    els.channelCount.textContent = "0 channels";
    setChannelStatus("请先填写 Bot Token，再刷新频道列表。");
    renderSlackChannelTable();
    return;
  }

  if (!options.force && state.slackChannelsLoadedToken === token) {
    return;
  }

  try {
    const result = await jsonFetch("/api/slack/channels", {
      method: "POST",
      body: {
        botToken: token
      }
    });

    state.slackChannels = Array.isArray(result.channels) ? result.channels : [];
    state.slackChannelsLoadedToken = token;
    els.channelCount.textContent = `${state.slackChannels.length} channels`;
    if (state.slackChannels.length > 0) {
      setChannelStatus("频道已加载，可在下方“频道绑定仓库”中选择并保存。");
    } else {
      setChannelStatus("未返回可用频道。请先将 Bot 邀请进频道后再刷新。");
    }
  } catch (error) {
    state.slackChannels = [];
    state.slackChannelsLoadedToken = "";
    els.channelCount.textContent = options.silent ? "0 channels（自动刷新失败）" : "0 channels";
    setChannelStatus("频道加载失败。请检查 Bot Token、应用权限和频道邀请状态。");
    renderSlackChannelTable();
    renderBindingTable();
    if (!options.silent) {
      throw error;
    }
    return;
  }

  renderSlackChannelTable();
  renderBindingTable();
}

function readSlackBotToken() {
  return String(els.slackForm.elements.namedItem("botToken")?.value || "").trim();
}

function updateWebhookBaseUrlHint() {
  if (!els.webhookBaseUrlHint) {
    return;
  }

  if (isSocketModeEnabled()) {
    els.webhookBaseUrlHint.textContent = "Socket Mode 已开启：Webhook Base URL 可留空。";
    return;
  }

  els.webhookBaseUrlHint.textContent =
    "Socket Mode 关闭时需要填写公网可访问地址；Socket Mode 开启时可留空。";
}

function isSocketModeEnabled() {
  const input = els.slackForm.elements.namedItem("useSocketMode");
  return Boolean(input?.checked);
}

function setChannelStatus(text) {
  if (els.channelStatus) {
    els.channelStatus.textContent = text;
  }
}

function renderSlackChannelTable() {
  els.channelTableBody.innerHTML = "";

  state.slackChannels.forEach((channel) => {
    const tr = document.createElement("tr");
    tr.appendChild(td(channel.name));
    tr.appendChild(td(channel.id));
    const type = document.createElement("span");
    type.className = `ch-type ${channel.is_private ? "private" : "public"}`;
    type.textContent = channel.is_private ? "private" : "public";
    tr.appendChild(tdNode(type));
    els.channelTableBody.appendChild(tr);
  });
}

function renderBoardCards() {
  const cards = Array.isArray(state.boardItems) ? state.boardItems : [];
  const processing = cards.filter((item) => isInProgressBoardState(item.state));
  const completed = cards.filter((item) => item.state === "completed");
  els.boardCount.textContent = `处理中 ${processing.length} | 已完成 ${completed.length}`;
  els.boardProcessingCount.textContent = String(processing.length);
  els.boardCompletedCount.textContent = String(completed.length);
  renderBoardColumn(els.boardProcessingCards, els.boardProcessingEmpty, processing);
  renderBoardColumn(els.boardCompletedCards, els.boardCompletedEmpty, completed);
}

function renderBoardColumn(containerEl, emptyEl, cards) {
  containerEl.innerHTML = "";
  emptyEl.style.display = cards.length ? "none" : "block";

  cards.forEach((item, index) => {
    const card = document.createElement("article");
    card.className = "board-card";
    card.style.setProperty("--card-accent", resolveBoardCardAccent(item, index));

    const header = document.createElement("header");
    header.className = "board-card-head";

    const issue = document.createElement("p");
    issue.className = "board-issue";
    issue.textContent = `#${item.issueNumber}`;

    const repo = document.createElement("p");
    repo.className = "board-repo";
    repo.textContent = item.repoFullName || item.repoId;

    const statusBadge = document.createElement("span");
    statusBadge.className = `board-state ${isInProgressBoardState(item.state) ? "processing" : "completed"}`;
    statusBadge.textContent = isInProgressBoardState(item.state) ? "处理中" : "已完成";

    const meta = document.createElement("p");
    meta.className = "board-time";
    meta.textContent = buildBoardTimeText(item);

    const summary = document.createElement("p");
    summary.className = "board-summary";
    summary.textContent = toPlain(item.summary) || "暂无 summary";

    const openButton = document.createElement("button");
    openButton.className = "ghost board-open";
    openButton.type = "button";
    openButton.textContent = "查看详情";
    openButton.addEventListener("click", () => openBoardDetail(item));

    header.appendChild(issue);
    header.appendChild(statusBadge);

    card.appendChild(header);
    card.appendChild(repo);
    card.appendChild(meta);
    card.appendChild(summary);
    card.appendChild(openButton);
    containerEl.appendChild(card);
  });
}

async function openBoardDetail(item) {
  const requestId = state.activeBoardRequestId + 1;
  state.activeBoardRequestId = requestId;
  state.activeBoardItem = item;
  renderBoardDetailLoading(item);
  els.boardModal.classList.remove("hidden");
  document.body.classList.add("modal-open");

  try {
    const detailRes = await jsonFetch(`/api/board/${encodeURIComponent(item.repoId)}/${item.issueNumber}`);
    if (!state.activeBoardItem || state.activeBoardRequestId !== requestId) {
      return;
    }
    renderBoardDetail(item, detailRes.item || null);
  } catch (error) {
    if (!state.activeBoardItem || state.activeBoardRequestId !== requestId) {
      return;
    }
    renderBoardDetailError(item, error);
  }
}

function renderBoardDetailLoading(item) {
  const statusText = isInProgressBoardState(item.state) ? "处理中" : "已完成";
  els.boardTitle.textContent = `${item.repoFullName} #${item.issueNumber}`;
  els.boardMeta.textContent = `状态：${statusText} | 正在加载详情...`;
  els.boardIssueTitle.textContent = "正在加载 Issue 内容...";
  els.boardIssueBody.innerHTML = '<p class="md-empty">正在拉取原始 Issue 内容...</p>';
  els.boardDiscussion.innerHTML = '<p class="md-empty">正在拉取讨论时间线...</p>';
  renderMarkdownToElement(els.boardSummary, "正在加载 summary...");
  renderMarkdownToElement(els.boardRootCause, "正在加载 root cause...");
  renderMarkdownToElement(els.boardSolution, "正在加载 solution...");
  renderBoardLinks(item.issueUrl, item.prUrl);
}

function renderBoardDetail(item, detail) {
  const source = detail || {};
  const issueSource = source.issue || null;
  const discussion = Array.isArray(source.discussion) ? source.discussion : [];
  const statusText = isInProgressBoardState(item.state) ? "处理中" : "已完成";
  const timeLabel = item.state === "completed" ? "关闭时间" : "更新时间";
  const issueTime = formatDisplayTime(source.closedAt || source.updatedAt || item.closedAt || item.updatedAt);
  const issueState = String(issueSource?.state || "").trim();
  const stateText = issueState ? ` | Issue 状态：${issueState}` : "";

  els.boardTitle.textContent = `${item.repoFullName} #${item.issueNumber}`;
  els.boardMeta.textContent = `状态：${statusText} | ${timeLabel}：${issueTime}${stateText}`;
  renderBoardLinks(source.issue?.url || source.issueUrl || item.issueUrl, source.prUrl || item.prUrl);

  const issueTitle = String(issueSource?.title || "").trim();
  els.boardIssueTitle.textContent = issueTitle || "原始 Issue";
  renderMarkdownToElement(els.boardIssueBody, String(issueSource?.body || ""), String(issueSource?.bodyHtml || ""));
  renderDiscussion(discussion);

  renderMarkdownToElement(els.boardSummary, String(source.summary || item.summary || ""));
  renderMarkdownToElement(els.boardRootCause, String(source.rootCause || item.rootCause || ""));
  renderMarkdownToElement(els.boardSolution, String(source.solution || item.solution || ""));
}

function renderBoardDetailError(item, error) {
  const message = error instanceof Error ? error.message : String(error);
  els.boardTitle.textContent = `${item.repoFullName} #${item.issueNumber}`;
  els.boardMeta.textContent = `详情加载失败：${message}`;
  els.boardIssueTitle.textContent = "详情加载失败";
  els.boardIssueBody.innerHTML = `<p class="md-empty">${escapeHtml(message)}</p>`;
  els.boardDiscussion.innerHTML = '<p class="md-empty">暂无讨论内容。</p>';
  renderMarkdownToElement(els.boardSummary, item.summary || "");
  renderMarkdownToElement(els.boardRootCause, item.rootCause || "");
  renderMarkdownToElement(els.boardSolution, item.solution || "");
  renderBoardLinks(item.issueUrl, item.prUrl);
}

function renderBoardLinks(issueUrl, prUrlValue) {
  const issue = String(issueUrl || "").trim();
  const prUrl = String(prUrlValue || "").trim();
  els.boardIssueLink.href = issue || "#";
  els.boardIssueLink.textContent = issue || "原始 Issue";

  if (prUrl) {
    els.boardPrLink.href = prUrl;
    els.boardPrLink.textContent = prUrl;
    els.boardPrLink.style.display = "inline-flex";
    return;
  }

  els.boardPrLink.href = "#";
  els.boardPrLink.textContent = "未提供 PR";
  els.boardPrLink.style.display = "none";
}

function renderDiscussion(comments) {
  els.boardDiscussion.innerHTML = "";
  if (!comments.length) {
    els.boardDiscussion.innerHTML = '<p class="md-empty">暂无评论讨论。</p>';
    return;
  }

  comments.forEach((comment) => {
    const article = document.createElement("article");
    article.className = "board-comment";

    const head = document.createElement("header");
    head.className = "board-comment-head";

    const author = document.createElement("span");
    author.className = "board-comment-author";
    author.textContent = `@${String(comment.author || "unknown")}`;

    const time = document.createElement("time");
    time.className = "board-comment-time";
    time.textContent = formatDisplayTime(comment.createdAt || comment.updatedAt);

    head.appendChild(author);
    head.appendChild(time);

    const link = String(comment.url || "").trim();
    if (link) {
      const anchor = document.createElement("a");
      anchor.href = link;
      anchor.target = "_blank";
      anchor.rel = "noreferrer";
      anchor.textContent = "原文";
      head.appendChild(anchor);
    }

    const content = document.createElement("div");
    content.className = "board-markdown";
    content.innerHTML = renderMarkdownHtml(comment.body, comment.bodyHtml);

    article.appendChild(head);
    article.appendChild(content);
    els.boardDiscussion.appendChild(article);
  });
}

function closeBoardDetail() {
  if (!state.activeBoardItem) {
    return;
  }
  state.activeBoardItem = null;
  state.activeBoardRequestId += 1;
  els.boardModal.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function renderMarkdownToElement(element, markdown, html = "") {
  element.innerHTML = renderMarkdownHtml(markdown, html);
}

function renderMarkdownHtml(markdown, html = "") {
  const normalizedHtml = sanitizeHtmlFragment(html);
  if (normalizedHtml) {
    return normalizedHtml;
  }
  return simpleMarkdownToHtml(markdown);
}

function sanitizeHtmlFragment(html) {
  const value = String(html || "").trim();
  if (!value) {
    return "";
  }
  return value
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, "");
}

function simpleMarkdownToHtml(markdown) {
  const source = String(markdown || "").replace(/\r\n?/g, "\n").trim();
  if (!source) {
    return '<p class="md-empty">暂无内容</p>';
  }

  const codeBlocks = [];
  const withCodeTokens = source.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const token = `@@CODEBLOCK_${codeBlocks.length}@@`;
    codeBlocks.push({
      lang: String(lang || "").trim(),
      code: String(code || "")
    });
    return token;
  });

  const blocks = withCodeTokens.split(/\n{2,}/);
  const rendered = blocks
    .map((block) => renderMarkdownBlock(block))
    .filter(Boolean)
    .join("");

  return restoreCodeBlocks(rendered, codeBlocks);
}

function renderMarkdownBlock(block) {
  const text = String(block || "").trim();
  if (!text) {
    return "";
  }

  if (/^@@CODEBLOCK_\d+@@$/.test(text)) {
    return text;
  }

  const headingMatch = text.match(/^(#{1,6})\s+(.+)$/);
  if (headingMatch) {
    const level = headingMatch[1].length;
    return `<h${level}>${renderInlineMarkdown(headingMatch[2])}</h${level}>`;
  }

  if (/^(-{3,}|\*{3,}|_{3,})$/.test(text)) {
    return "<hr />";
  }

  const lines = text.split("\n").map((line) => line.trim());
  if (lines.every((line) => /^[-*]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^[-*]\s+/, ""))}</li>`).join("")}</ul>`;
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    return `<ol>${lines.map((line) => `<li>${renderInlineMarkdown(line.replace(/^\d+\.\s+/, ""))}</li>`).join("")}</ol>`;
  }

  if (lines.every((line) => /^>\s?/.test(line))) {
    const body = lines.map((line) => renderInlineMarkdown(line.replace(/^>\s?/, ""))).join("<br />");
    return `<blockquote>${body}</blockquote>`;
  }

  return `<p>${lines.map((line) => renderInlineMarkdown(line)).join("<br />")}</p>`;
}

function renderInlineMarkdown(text) {
  const codeSpans = [];
  const withTokens = String(text || "").replace(/`([^`]+)`/g, (_match, code) => {
    const token = `@@CODESPAN_${codeSpans.length}@@`;
    codeSpans.push(String(code || ""));
    return token;
  });

  let html = escapeHtml(withTokens);
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
    return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\*([^*\n]+)\*/g, "<em>$1</em>");
  html = html.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, (_match, prefix, url) => {
    return `${prefix}<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`;
  });

  html = html.replace(/@@CODESPAN_(\d+)@@/g, (_match, index) => {
    const code = codeSpans[Number(index)] || "";
    return `<code>${escapeHtml(code)}</code>`;
  });
  return html;
}

function restoreCodeBlocks(html, blocks) {
  return html.replace(/@@CODEBLOCK_(\d+)@@/g, (_match, index) => {
    const item = blocks[Number(index)];
    if (!item) {
      return "";
    }
    const lang = item.lang ? ` class="language-${escapeHtml(item.lang)}"` : "";
    const code = escapeHtml(item.code.replace(/\n$/, ""));
    return `<pre><code${lang}>${code}</code></pre>`;
  });
}

function isInProgressBoardState(stateValue) {
  return stateValue === "triaging" || stateValue === "scheduled" || stateValue === "implementing";
}

function resolveBoardCardAccent(item, index) {
  if (isInProgressBoardState(item.state)) {
    return index % 2 === 0 ? "#d97706" : "#f59e0b";
  }
  return index % 2 === 0 ? "#0f766e" : "#0f172a";
}

function buildBoardTimeText(item) {
  if (item.state === "completed") {
    return `Closed: ${formatDisplayTime(item.closedAt || item.updatedAt)}`;
  }
  return `Updated: ${formatDisplayTime(item.updatedAt || item.closedAt)}`;
}

async function saveRepository(payload) {
  await jsonFetch("/api/repositories", {
    method: "POST",
    body: payload
  });
}

async function detectRepoAndFill() {
  const localPath = String(els.repoForm.elements.namedItem("localPath")?.value || "").trim();
  if (!localPath) {
    alert("请先填写 Local Path");
    return;
  }
  const detected = await detectRepository(localPath);
  setInput(els.repoForm, "detectedRepo", detected.fullName);
}

async function detectRepository(localPath) {
  const detected = await jsonFetch("/api/repositories/detect", {
    method: "POST",
    body: { localPath }
  });
  if (!detected.ok) {
    throw new Error(detected.error || "仓库识别失败");
  }
  return detected;
}

function formatSlackBinding(repo) {
  if (!repo.slack?.enabled) {
    return "disabled";
  }

  const channel = state.slackChannels.find((item) => item.id === repo.slack.channelId);
  const channelLabel = channel ? `${channel.name}(${channel.id})` : repo.slack.channelId || "-";
  return `${repo.slack.transport}@${channelLabel}`;
}

async function jsonFetch(url, options = {}) {
  const res = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  if (!res.ok) {
    throw new Error(await res.text());
  }

  return res.json();
}

function td(text) {
  const node = document.createElement("td");
  node.textContent = String(text || "");
  return node;
}

function tdNode(child) {
  const node = document.createElement("td");
  node.appendChild(child);
  return node;
}

function setInput(form, name, value) {
  const el = form.elements.namedItem(name);
  if (el) {
    el.value = value ?? "";
  }
}

function setCheckbox(form, name, value) {
  const el = form.elements.namedItem(name);
  if (el) {
    el.checked = Boolean(value);
  }
}

function escapeHtml(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toPlain(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function formatDisplayTime(value) {
  const ts = Date.parse(String(value || ""));
  if (!Number.isFinite(ts)) {
    return "-";
  }
  return new Date(ts).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function bindTabEvents() {
  const hash = window.location.hash;
  const hashTab = hash === "#slack" ? "slack" : hash === "#board" ? "board" : "issue";
  activateTab(hashTab, false);

  els.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const tab = button.dataset.tab === "slack" ? "slack" : button.dataset.tab === "board" ? "board" : "issue";
      activateTab(tab);
    });
  });
}

function activateTab(tab, updateHash = true) {
  els.tabButtons.forEach((button) => {
    const isActive = button.dataset.tab === tab;
    button.classList.toggle("active", isActive);
  });

  els.tabContents.forEach((section) => {
    const isActive = section.id === `tab-${tab}`;
    section.classList.toggle("active", isActive);
  });

  if (updateHash) {
    window.location.hash = tab;
  }
}
