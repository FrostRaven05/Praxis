const app = document.querySelector("#app");
const detailDialog = document.querySelector("#detail-dialog");
const confirmDialog = document.querySelector("#confirm-dialog");
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  sync: '<path d="M20 7A9 9 0 0 0 5 5L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/>',
  settings:
    '<path d="m12 2 2 3 3 .3 1.7 2.9-1.3 3 1.3 3L17 17l-3 .3-2 3-2-3-3-.3-1.7-2.8 1.3-3-1.3-3L7 5.3l3-.3Z"/><circle cx="12" cy="11.3" r="3"/>',
  arrow: '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  refresh: '<path d="M20 7A9 9 0 1 0 21 15M20 3v5h-5"/>',
  device:
    '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>',
  data: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 4 16 4 16 0V5M4 12c0 4 16 4 16 0"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>',
  download: '<path d="M12 3v12m-5-5 5 5 5-5M4 17v4h16v-4"/>',
  logout: '<path d="M9 3H4v18h5m5-14 5 5-5 5m-5-5h12"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  shield:
    '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  model:
    '<rect x="4" y="4" width="16" height="16" rx="2"/><path d="M9 9h.01M15 9h.01M8 15h8"/>',
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.grid}</svg>`;
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        character
      ],
  );
const number = (value) => Number(value ?? 0).toLocaleString("zh-CN");
const date = (value) =>
  value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "未记录";
const shortDate = (value) =>
  value ? new Date(value).toLocaleDateString("zh-CN") : "未记录";
const kindNames = {
  capture: "收件箱",
  task: "任务",
  project: "项目",
  section: "分区",
  plan: "每日安排",
  record: "记录",
  habit: "习惯",
  habit_check: "习惯打卡",
  recurrence: "重复规则",
  review: "回顾",
  view: "视图",
  settings: "偏好设置",
  strategy: "策略",
  decision: "决策",
  focus: "专注记录",
  desktop_row: "桌面数据",
};
const views = {
  overview: ["数据概览", "用户与云端数据，一目了然。"],
  users: ["用户管理", "查找用户，管理账号与登录设备。"],
  sync: ["同步数据", "查看云端数据数量与同步写入情况。"],
  model: ["模型设置", "配置规划助手使用的模型服务。"],
  system: ["系统状态", "查看服务运行情况。"],
};
const state = {
  view: "overview",
  page: 1,
  q: "",
  status: "all",
  overview: null,
  users: null,
  model: null,
  system: null,
  selected: null,
  pending: null,
  revision: 0,
};
let searchTimer, toastTimer;
let detailRevision = 0;

async function api(path, options = {}) {
  const response = await fetch(`/admin/api/${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "X-Praxis-Admin": "1",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const body = await response.json();
  if (!response.ok) {
    const messages = {
      UNAUTHORIZED: "登录已过期，请重新登录。",
      INVALID_CREDENTIALS: "管理密钥不正确，请重试。",
      ADMIN_NOT_CONFIGURED:
        "管理后台尚未启用。请在服务器配置管理员密钥哈希后重启服务。",
      RATE_LIMITED: "尝试次数过多，请在 15 分钟后重试。",
      INVALID_REQUEST: "输入格式有误，请检查后重试。",
      USER_NOT_FOUND: "该用户不存在，请刷新列表。",
      EMAIL_CONFIRMATION_MISMATCH: "邮箱与所选用户不一致，请重新输入。",
      INVALID_ORIGIN: "请求验证失败，请刷新页面后重试。",
    };
    if (response.status === 401 && path !== "login") {
      detailDialog.close();
      confirmDialog.close();
      state.revision++;
      renderLogin("登录已过期，请重新登录。");
    }
    const error = new Error(messages[body.error] || "操作未完成，请稍后重试。");
    error.status = response.status;
    throw error;
  }
  return body;
}
function toast(message) {
  const element = document.querySelector("#toast");
  element.textContent = message;
  element.classList.add("visible");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => element.classList.remove("visible"), 3500);
}
function empty(title, text = "") {
  return `<div class="empty"><strong>${escape(title)}</strong>${escape(text)}</div>`;
}
function renderLogin(message = "") {
  app.innerHTML = `<div class="login-page"><section class="login-brand"><div class="brand"><span class="brand-mark">p.</span>Praxis</div><h1>让每一个行动，<br>有序发生。</h1><p>连接用户、数据与每一次同步。<br>在一个清晰的工作台里，掌握 Praxis 的运行情况。</p><div class="login-caption">TURN INTENT INTO ACTION.</div></section><section class="login-form-wrap"><div class="eyebrow">PRAXIS ADMIN</div><h2>登录管理控制台</h2><p class="subtitle">使用独立的管理员密钥访问后台。</p><form id="login-form"><label class="field-label" for="admin-token">管理密钥</label><input class="form-input" id="admin-token" name="token" type="password" required maxlength="512" autocomplete="current-password" placeholder="输入管理员密钥"/><div class="login-error" role="alert">${escape(message)}</div><button class="button primary" type="submit">进入控制台 ${icon("arrow")}</button></form><p class="login-help">${icon("shield")} 登录会话有效期为 8 小时。<br>管理密钥由服务维护人员配置，与应用账号独立。</p></section></div>`;
}
function shell() {
  app.innerHTML = `<div class="shell"><aside class="sidebar"><div class="brand"><span class="brand-mark">p.</span>Praxis</div><p class="brand-caption">管理控制台</p><p class="nav-label">工作空间</p><nav class="nav" aria-label="后台导航">${[
    ["overview", "grid"],
    ["users", "users"],
    ["sync", "sync"],
  ]
    .map(([view, i]) => navButton(view, i))
    .join("")}<div class="nav-separator"></div><p class="nav-label">管理</p>${[
    ["model", "model"],
    ["system", "settings"],
  ]
    .map(([view, i]) => navButton(view, i))
    .join(
      "",
    )}</nav><div class="sidebar-bottom"><div class="environment"><strong>Praxis 云端服务</strong><span>账号与全域数据同步</span></div><div class="sidebar-account"><span class="avatar">AD</span><div>管理员<small>Administrator</small></div><button class="icon-button" data-action="logout" aria-label="退出登录" title="退出登录">${icon("logout")}</button></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumbs"><button class="icon-button mobile-toggle" data-action="menu" aria-label="展开导航">${icon("menu")}</button><span>管理控制台</span><span>/</span><strong id="breadcrumb"></strong></div><div class="topbar-right"><span class="health" id="connection-state">已安全登录</span><span class="date-label">${escape(new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }))}</span><span class="avatar" aria-label="管理员">AD</span></div></header><div class="content"><div class="page-heading"><div><h1 id="page-title"></h1><p class="subtitle" id="subtitle"></p></div><div class="heading-actions"><button class="button" data-action="refresh">${icon("refresh")}刷新数据</button></div></div><div id="error" role="alert"></div><div id="view-content">${empty("正在获取数据…")}</div><footer class="footer"><span>© ${new Date().getFullYear()} Praxis · Turn intent into action.</span><span id="updated-at"></span></footer></div></main></div>`;
  updateNavigation();
}
function navButton(view, i) {
  return `<button class="nav-button" data-view="${view}">${icon(i)}${views[view][0]}</button>`;
}
function updateNavigation() {
  document.querySelectorAll("[data-view]").forEach((element) => {
    element.classList.toggle("active", element.dataset.view === state.view);
    element.setAttribute(
      "aria-current",
      element.dataset.view === state.view ? "page" : "false",
    );
  });
  ["page-title", "breadcrumb"].forEach(
    (id) => (document.getElementById(id).textContent = views[state.view][0]),
  );
  document.querySelector("#subtitle").textContent = views[state.view][1];
}
function metrics(sync = false) {
  const o = state.overview;
  const cards = sync
    ? [
        ["云端数据", o.entities, "data", "不含已删除数据"],
        ["今日同步写入", o.todayOperations, "sync", "UTC 当日操作批次"],
        ["累计同步写入", o.operations, "sync", "已接收操作批次"],
      ]
    : [
        ["注册用户", o.users, "users", `${number(o.disabledUsers)} 个已禁用`],
        ["有效登录设备", o.activeDevices, "device", "有效会话，非实时在线"],
        ["云端数据", o.entities, "data", "不含已删除数据"],
        ["今日同步写入", o.todayOperations, "sync", "UTC 当日操作批次"],
      ];
  return `<div class="metrics${sync ? " metrics-three" : ""}">${cards.map(([title, value, i, foot]) => `<article class="metric"><div class="metric-top">${title}<span class="metric-icon">${icon(i)}</span></div><div class="metric-value">${number(value)}</div><div class="metric-foot">${escape(foot)}</div></article>`).join("")}</div>`;
}
function kindRows(kinds, limit = 6) {
  const total = kinds.reduce((sum, item) => sum + item.count, 0);
  const displayed = kinds.slice(0, limit);
  if (kinds.length > limit)
    displayed.push({
      kind: "其他数据",
      count: kinds.slice(limit).reduce((sum, item) => sum + item.count, 0),
    });
  return displayed
    .map(
      (item) =>
        `<div class="kind-row"><span class="kind-dot"></span><span>${escape(kindNames[item.kind] || item.kind)}</span><strong>${number(item.count)} · ${total ? Math.round((item.count / total) * 100) : 0}%</strong><svg class="kind-bar" viewBox="0 0 100 5" preserveAspectRatio="none" aria-hidden="true"><rect width="100" height="5" rx="2.5"/><rect class="bar-value" width="${total ? (item.count / total) * 100 : 0}" height="5" rx="2.5"/></svg></div>`,
    )
    .join("");
}

function userIdentity(user) {
  return `<div class="user-cell"><span class="avatar">${escape((user.displayName || user.email).slice(0, 2).toUpperCase())}</span><span><span class="user-name">${escape(user.displayName)}</span><span class="user-email">${escape(user.email)}</span></span></div>`;
}
function badge(user) {
  return `<span class="badge${user.disabled ? " disabled" : ""}">${user.disabled ? "已禁用" : "正常"}</span>`;
}
function pagination(result) {
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  return `<div class="table-footer"><span>共 ${number(result.total)} 条记录 · 每页 ${result.pageSize} 条</span><div class="pagination"><button class="button" data-page="${result.page - 1}" ${result.page <= 1 ? "disabled" : ""} aria-label="上一页">上一页</button><span class="current-page">${result.page} / ${pages}</span><button class="button" data-page="${result.page + 1}" ${result.page >= pages ? "disabled" : ""} aria-label="下一页">下一页</button></div></div>`;
}
function usersTable(compact = false) {
  const result = state.users;
  return `<section class="panel table-panel"><div class="panel-head"><div><h2>${compact ? "最近注册用户" : "用户列表"}</h2><p>${compact ? "关注新用户与他们的同步情况" : "支持按名称、邮箱或用户 ID 搜索"}</p></div>${compact ? `<button class="text-button" data-action="goto-users">查看全部 ${icon("arrow")}</button>` : `<button class="button" data-action="export">${icon("download")}导出当前页</button>`}</div>${compact ? "" : `<div class="toolbar"><label class="search-box">${icon("search")}<input id="user-search" aria-label="搜索用户" placeholder="搜索名称、邮箱或用户 ID…" value="${escape(state.q)}" maxlength="200"/></label><select id="status-filter" aria-label="账号状态"><option value="all" ${state.status === "all" ? "selected" : ""}>全部状态</option><option value="active" ${state.status === "active" ? "selected" : ""}>正常账号</option><option value="disabled" ${state.status === "disabled" ? "selected" : ""}>已禁用</option></select></div>`}${
    result.users.length
      ? `<div class="table-scroll"><table><thead><tr><th>用户</th><th>账号状态</th><th>有效设备</th><th>云端数据</th><th>注册时间</th><th>操作</th></tr></thead><tbody>${result.users
          .slice(0, compact ? 5 : 12)
          .map(
            (user) =>
              `<tr><td>${userIdentity(user)}</td><td>${badge(user)}</td><td>${number(user.devices)} <span>台</span></td><td>${number(user.entities)}</td><td>${escape(shortDate(user.createdAt))}</td><td><button class="text-button" data-user="${escape(user.id)}">查看详情 ${icon("chevron")}</button></td></tr>`,
          )
          .join("")}</tbody></table></div>`
      : empty(
          state.q || state.status !== "all"
            ? "未找到匹配用户"
            : "还没有注册用户",
          state.q || state.status !== "all"
            ? "请调整搜索条件或账号状态。"
            : "用户通过桌面端或移动端注册后将在这里显示。",
        )
  }${compact ? `<div class="table-footer"><span>当前服务共 ${number(result.total)} 个注册账号</span><span>旧账号注册时间显示为「未记录」</span></div>` : pagination(result)}</section>`;
}
function syncView() {
  const o = state.overview;
  return `${metrics(true)}<section class="panel table-panel"><div class="panel-head"><div><h2>数据分类</h2><p>仅统计未删除的云端数据</p></div><span class="muted">${o.kinds.length} 类</span></div>${o.kinds.length ? `<div class="table-scroll"><table><thead><tr><th>数据类型</th><th class="numeric">数量</th></tr></thead><tbody>${o.kinds.map((item) => `<tr><td>${escape(kindNames[item.kind] || item.kind)}</td><td class="numeric">${number(item.count)}</td></tr>`).join("")}</tbody></table></div>` : empty("暂无同步数据", "用户完成首次同步后将在这里显示。")}</section>`;
}
function systemView() {
  const s = state.system;
  const rows = [
    ["服务", s.service],
    [
      "连续运行",
      `${number(Math.floor(s.uptimeSeconds / 3600))} 小时 ${Math.floor(s.uptimeSeconds / 60) % 60} 分钟`,
    ],
    ["数据库大小", `${(s.databaseBytes / 1024 / 1024).toFixed(2)} MB`],
    ["检查时间", date(s.checkedAt)],
  ];
  return `<section class="panel settings-panel"><div class="panel-head"><h2>服务运行</h2><span class="badge${s.status === "ok" ? "" : " disabled"}">${s.status === "ok" ? "正常运行" : "状态异常"}</span></div><dl class="system-body">${rows.map(([label, value]) => `<div class="system-row"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl></section>`;
}
function modelView() {
  const model = state.model;
  if (!model) return empty("正在读取模型设置…");
  return `<section class="panel settings-panel"><div class="panel-head"><h2>规划助手</h2><span class="badge${model.enabled ? "" : " disabled"}">${model.enabled ? "已配置" : "待配置"}</span></div><form class="model-form" id="model-form"><div class="form-grid"><div><label class="field-label" for="model-provider">服务</label><select class="form-input" id="model-provider" name="provider" data-previous="${escape(model.provider)}"><option value="deepseek"${model.provider === "deepseek" ? " selected" : ""}>DeepSeek</option><option value="openai"${model.provider === "openai" ? " selected" : ""}>OpenAI / 兼容接口</option></select></div><div><label class="field-label" for="model-name">模型</label><input class="form-input" id="model-name" name="model" required maxlength="200" value="${escape(model.model)}" placeholder="输入模型名称"></div></div><label class="field-label" for="model-base">接口地址</label><input class="form-input" id="model-base" name="baseUrl" type="url" required maxlength="300" value="${escape(model.baseUrl)}" placeholder="https://api.deepseek.com" aria-describedby="model-base-help"><p class="field-help" id="model-base-help">支持 HTTPS 服务地址，可填写自定义兼容接口。</p><label class="field-label" for="model-key">API 密钥</label><div class="secret-input"><input class="form-input" id="model-key" name="apiKey" type="password" maxlength="500" autocomplete="new-password" ${model.hasApiKey ? "" : "required"} placeholder="${model.hasApiKey ? "已保存，留空保留原密钥" : "输入 API 密钥"}" aria-describedby="model-key-help"><button type="button" class="icon-button" data-action="toggle-key" aria-label="显示 API 密钥" aria-pressed="false">显示</button></div><p class="field-help" id="model-key-help">${model.hasApiKey ? "已保存的密钥不会回显。" : "首次配置需要填写密钥。"}</p><p class="dialog-error" role="alert"></p><div class="form-footer"><span class="muted">${model.updatedAt ? `上次保存 ${escape(date(model.updatedAt))}` : model.source === "environment" ? "当前使用环境配置" : "保存后生效"}</span><button class="button primary" type="submit">保存模型设置</button></div></form></section>`;
}
function renderView() {
  const content = document.querySelector("#view-content");
  if (!content) return;
  const focus = document.activeElement?.id === "user-search";
  const start = focus ? document.activeElement.selectionStart : null;
  content.innerHTML =
    state.view === "overview"
      ? `${metrics()}${usersTable(true)}`
      : state.view === "users"
        ? usersTable()
        : state.view === "sync"
          ? syncView()
          : state.view === "model"
            ? modelView()
            : systemView();
  if (focus) {
    const input = document.querySelector("#user-search");
    input?.focus();
    if (start !== null) input?.setSelectionRange(start, start);
  }
}
async function load() {
  const revision = ++state.revision;
  const refresh = document.querySelector('[data-action="refresh"]');
  if (refresh) {
    refresh.classList.add("spin");
    refresh.disabled = true;
  }
  document.querySelector("#error")?.replaceChildren();
  try {
    let overview, users, system, model;
    if (state.view === "overview")
      [overview, users] = await Promise.all([api("overview"), api("users")]);
    if (state.view === "users")
      users = await api(
        `users?${new URLSearchParams({ page: String(state.page), q: state.q, status: state.status })}`,
      );
    if (state.view === "sync") overview = await api("overview");
    if (state.view === "model") model = await api("model");
    if (state.view === "system") system = await api("system");
    if (revision !== state.revision) return;
    if (overview) state.overview = overview;
    if (users) state.users = users;
    if (model) state.model = model;
    if (system) state.system = system;
    if (users && users.page > 1 && !users.users.length) {
      state.page = Math.max(1, Math.ceil(users.total / users.pageSize));
      await load();
      return;
    }
    renderView();
    document.querySelector("#updated-at").textContent =
      `更新于 ${date(overview?.updatedAt || system?.checkedAt || new Date().toISOString())}`;
    document.querySelector("#connection-state").textContent = "服务连接正常";
  } catch (error) {
    if (revision !== state.revision) return;
    const target = document.querySelector("#error");
    if (target)
      target.innerHTML = `<div class="error-banner">${escape(error.message)} <button class="text-button" data-action="refresh">重试</button></div>`;
    if (document.querySelector("#connection-state"))
      document.querySelector("#connection-state").textContent = "数据更新失败";
  } finally {
    if (revision === state.revision && refresh) {
      refresh.classList.remove("spin");
      refresh.disabled = false;
    }
  }
}
function navigate(view) {
  if (!views[view]) return;
  clearTimeout(searchTimer);
  state.view = view;
  state.page = 1;
  state.q = "";
  state.status = "all";
  history.replaceState(null, "", `#${view}`);
  document.querySelector(".shell")?.classList.remove("menu-open");
  updateNavigation();
  document.querySelector("#view-content").innerHTML = empty("正在获取数据…");
  load();
}
async function openUser(id, open = true) {
  const revision = ++detailRevision;
  if (open) {
    detailDialog.innerHTML = `<div class="dialog-header"><h2 id="detail-title">用户详情</h2><button class="icon-button" data-action="close-detail" aria-label="关闭">${icon("close")}</button></div>${empty("正在获取用户信息…")}`;
    detailDialog.showModal();
  }
  try {
    const result = await api(`users/${encodeURIComponent(id)}`);
    if (!detailDialog.open || revision !== detailRevision) return;
    state.selected = result;
    const { user, sessions, kinds } = result;
    detailDialog.innerHTML = `<div class="dialog-header"><h2 id="detail-title">用户详情</h2><button class="icon-button" data-action="close-detail" aria-label="关闭">${icon("close")}</button></div><div class="dialog-body">${userIdentity(user)}<div class="system-row"><dt>账号状态</dt><dd>${badge(user)}</dd></div><div class="system-row"><dt>注册时间</dt><dd>${escape(date(user.createdAt))}</dd></div><div class="system-row"><dt>最近登录</dt><dd>${escape(date(user.lastLoginAt))}</dd></div><div class="system-row"><dt>用户 ID</dt><dd class="mono">${escape(user.id)}</dd></div><h3 class="dialog-section-title">云端数据</h3>${kinds.length ? kindRows(kinds, 5) : '<p class="dialog-copy">暂无同步数据</p>'}<h3 class="dialog-section-title">有效登录设备 · ${sessions.length} 台</h3>${sessions.map((session) => `<div class="session-card"><div class="mono">${escape(session.deviceId)}</div><div class="session-card-footer"><span>到期 ${escape(date(session.expiresAt))}</span><button class="text-button" data-action="revoke-device" data-device="${escape(session.deviceId)}">撤销登录</button></div></div>`).join("") || '<p class="dialog-copy">暂无有效登录设备</p>'}</div><div class="dialog-actions"><button class="button danger delete-user" data-action="delete-user">删除用户</button><button class="button" data-action="revoke-all" ${sessions.length ? "" : "disabled"}>撤销全部登录</button><button class="button ${user.disabled ? "primary" : "danger"}" data-action="toggle-status">${user.disabled ? "启用账号" : "禁用账号"}</button></div>`;
  } catch (error) {
    if (detailDialog.open) {
      detailDialog.close();
      toast(error.message);
    }
  }
}
function confirmAction(action, deviceId) {
  const user = state.selected.user;
  const deleting = action === "delete-user";
  const danger = deleting || (action === "toggle-status" && !user.disabled);
  const title = deleting
    ? "删除用户"
    : action === "toggle-status"
      ? user.disabled
        ? "启用账号"
        : "禁用账号"
      : action === "revoke-device"
        ? "撤销设备登录"
        : "撤销全部登录";
  const description = deleting
    ? "将永久删除此账号、全部云端数据与模型运行记录，并撤销所有登录。此操作无法撤销，设备上的本地数据不受影响。"
    : action === "toggle-status"
      ? user.disabled
        ? "启用后，用户可重新登录并继续同步。"
        : "将撤销全部登录，并阻止该用户登录和同步。已有数据会保留。"
      : "所选设备需要重新登录才能继续同步，已有数据会保留。";
  state.pending = { id: user.id, action, deviceId, disabled: !user.disabled };
  confirmDialog.innerHTML = `<form id="action-form"><div class="dialog-header"><h2 id="confirm-title">${title}</h2><button type="button" class="icon-button" data-action="close-confirm" aria-label="关闭">${icon("close")}</button></div><div class="dialog-body"><p class="dialog-copy${deleting ? " destructive-copy" : ""}"><strong>${escape(user.email)}</strong><br>${description}</p>${deleting ? `<label for="confirm-email" class="field-label">输入用户邮箱以确认</label><input id="confirm-email" class="form-input" name="email" type="email" required autocomplete="off" maxlength="254" placeholder="${escape(user.email)}">` : ""}<label for="action-reason" class="field-label">操作原因 <span>（必填）</span></label><textarea id="action-reason" class="form-input" name="reason" rows="2" required maxlength="200" placeholder="请填写本次操作的原因"></textarea><div class="dialog-error" role="alert"></div></div><div class="dialog-actions"><button type="button" class="button" data-action="close-confirm">取消</button><button class="button ${danger ? "danger" : "primary"}" type="submit">确认${title}</button></div></form>`;
  confirmDialog.showModal();
  document
    .querySelector(deleting ? "#confirm-email" : "#action-reason")
    .focus();
}
function exportUsers() {
  if (!state.users?.users.length) {
    toast("当前没有可导出的用户。");
    return;
  }
  const cell = (value) =>
    `"${String(value ?? "")
      .replace(/^[=+@\-\t\r]/, "'$&")
      .replaceAll('"', '""')}"`;
  const rows = [
    ["用户ID", "名称", "邮箱", "状态", "有效设备", "云端数据", "注册时间"],
    ...state.users.users.map((user) => [
      user.id,
      user.displayName,
      user.email,
      user.disabled ? "禁用" : "正常",
      user.devices,
      user.entities,
      user.createdAt || "未记录",
    ]),
  ];
  const blob = new Blob(
    ["\uFEFF" + rows.map((row) => row.map(cell).join(",")).join("\r\n")],
    { type: "text/csv;charset=utf-8" },
  );
  const url = URL.createObjectURL(blob),
    link = document.createElement("a");
  link.href = url;
  link.download = `Praxis-用户-第${state.users.page}页.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast("已导出当前页用户。");
}
document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target || target.disabled) return;
  if (target.dataset.view) {
    navigate(target.dataset.view);
    return;
  }
  if (target.dataset.page) {
    state.page = Number(target.dataset.page);
    await load();
    return;
  }
  if (target.dataset.user) {
    await openUser(target.dataset.user);
    return;
  }
  const action = target.dataset.action;
  if (action === "refresh") await load();
  if (action === "goto-users") navigate("users");
  if (action === "menu")
    document.querySelector(".shell")?.classList.toggle("menu-open");
  if (action === "export") exportUsers();
  if (action === "toggle-key") {
    const input = document.querySelector("#model-key");
    const visible = input.type === "password";
    input.type = visible ? "text" : "password";
    target.textContent = visible ? "隐藏" : "显示";
    target.setAttribute("aria-label", `${visible ? "隐藏" : "显示"} API 密钥`);
    target.setAttribute("aria-pressed", String(visible));
  }
  if (action === "close-detail") detailDialog.close();
  if (action === "close-confirm") confirmDialog.close();
  if (
    ["revoke-device", "revoke-all", "toggle-status", "delete-user"].includes(
      action,
    )
  )
    confirmAction(action, target.dataset.device);
  if (action === "logout") {
    target.disabled = true;
    try {
      await api("logout", { method: "POST" });
      state.revision++;
      detailDialog.close();
      confirmDialog.close();
      state.selected = null;
      renderLogin();
    } catch (error) {
      toast(error.message);
      target.disabled = false;
    }
  }
});
document.addEventListener("input", (event) => {
  if (event.target.id === "user-search") {
    state.q = event.target.value;
    state.page = 1;
    state.revision++;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(load, 280);
  }
});
document.addEventListener("change", (event) => {
  if (event.target.id === "model-provider") {
    const presets = {
      deepseek: {
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
      },
      openai: { baseUrl: "https://api.openai.com/v1", model: "" },
    };
    const previous = presets[event.target.dataset.previous];
    const next = presets[event.target.value];
    const form = event.target.form;
    for (const name of ["baseUrl", "model"])
      if (
        !form.elements[name].value ||
        form.elements[name].value === previous[name]
      )
        form.elements[name].value = next[name];
    event.target.dataset.previous = event.target.value;
  }
  if (event.target.id === "status-filter") {
    state.status = event.target.value;
    state.page = 1;
    load();
  }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id === "model-form") {
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('[type="submit"]');
    submit.disabled = true;
    const body = {
      provider: form.elements.provider.value,
      baseUrl: form.elements.baseUrl.value.trim(),
      model: form.elements.model.value.trim(),
    };
    const apiKey = form.elements.apiKey.value.trim();
    if (apiKey) body.apiKey = apiKey;
    form.querySelector(".dialog-error").textContent = "";
    try {
      state.model = await api("model", {
        method: "PUT",
        body: JSON.stringify(body),
      });
      form.elements.apiKey.value = "";
      renderView();
      toast("模型设置已保存。");
    } catch (error) {
      form.querySelector(".dialog-error").textContent = error.message;
      submit.disabled = false;
    }
    return;
  }
  if (!["login-form", "action-form"].includes(event.target.id)) return;
  event.preventDefault();
  const form = event.target;
  const submit = form.querySelector('[type="submit"]');
  submit.disabled = true;
  if (form.id === "login-form") {
    try {
      await api("login", {
        method: "POST",
        body: JSON.stringify({ token: form.elements.token.value }),
      });
      form.reset();
      state.view = views[location.hash.slice(1)]
        ? location.hash.slice(1)
        : "overview";
      shell();
      await load();
    } catch (error) {
      form.querySelector(".login-error").textContent = error.message;
      submit.disabled = false;
    }
    return;
  }
  const reason = form.elements.reason.value.trim();
  if (!reason) {
    form.querySelector(".dialog-error").textContent = "请填写操作原因。";
    submit.disabled = false;
    return;
  }
  const pending = { ...state.pending };
  if (
    pending.action === "delete-user" &&
    form.elements.email.value.trim().toLowerCase() !== state.selected.user.email
  ) {
    form.querySelector(".dialog-error").textContent =
      "邮箱与所选用户不一致，请重新输入。";
    submit.disabled = false;
    return;
  }
  try {
    await api(
      `users/${encodeURIComponent(pending.id)}${pending.action === "delete-user" ? "" : pending.action === "toggle-status" ? "/status" : "/revoke"}`,
      {
        method: pending.action === "delete-user" ? "DELETE" : "POST",
        body: JSON.stringify({
          reason,
          ...(pending.action === "delete-user"
            ? { email: form.elements.email.value.trim() }
            : {}),
          ...(pending.action === "toggle-status"
            ? { disabled: pending.disabled }
            : pending.deviceId
              ? { deviceId: pending.deviceId }
              : {}),
        }),
      },
    );
    confirmDialog.close();
    if (pending.action === "delete-user") {
      detailRevision++;
      detailDialog.close();
      state.selected = null;
      state.pending = null;
      toast("用户及其云端数据已删除。");
      await load();
    } else {
      toast("操作已完成。");
      await Promise.all([openUser(pending.id, false), load()]);
    }
  } catch (error) {
    form.querySelector(".dialog-error").textContent = error.message;
    submit.disabled = false;
  }
});
try {
  await api("session");
  state.view = views[location.hash.slice(1)]
    ? location.hash.slice(1)
    : "overview";
  shell();
  await load();
} catch (error) {
  renderLogin(error.status === 401 ? "" : error.message);
}
