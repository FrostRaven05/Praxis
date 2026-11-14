const app = document.querySelector("#app");
const detailDialog = document.querySelector("#detail-dialog");
const confirmDialog = document.querySelector("#confirm-dialog");
const paths = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  users:
    '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/><circle cx="9" cy="7" r="4"/>',
  sync: '<path d="M20 7A9 9 0 0 0 5 5L2 8m0-5v5h5m-3 9a9 9 0 0 0 15 2l3-3m0 5v-5h-5"/>',
  log: '<rect x="5" y="3" width="14" height="18" rx="2"/><path d="M9 7h6m-6 5h6m-6 5h4"/>',
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
const actionNames = {
  admin_login: "管理员登录",
  disable_user: "禁用账号",
  enable_user: "启用账号",
  revoke_sessions: "撤销设备登录",
};
const views = {
  overview: ["数据概览", "了解 Praxis 的账号、同步与数据情况。", "OVERVIEW"],
  users: [
    "用户管理",
    "管理用户账号与设备登录，保持数据有序。",
    "USER MANAGEMENT",
  ],
  sync: ["同步数据", "查看云端数据分布与同步写入情况。", "SYNC & DATA"],
  audit: ["操作日志", "每一次管理操作，都有迹可循。", "AUDIT LOG"],
  system: ["系统状态", "查看当前服务与管理控制台的运行信息。", "SYSTEM STATUS"],
};
const state = {
  view: "overview",
  page: 1,
  q: "",
  status: "all",
  overview: null,
  users: null,
  audit: null,
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
    ["audit", "log"],
    ["system", "settings"],
  ]
    .map(([view, i]) => navButton(view, i))
    .join(
      "",
    )}</nav><div class="sidebar-bottom"><div class="environment"><strong>Praxis 云端服务</strong><span>账号与全域数据同步</span></div><div class="sidebar-account"><span class="avatar">AD</span><div>管理员<small>Administrator</small></div><button class="icon-button" data-action="logout" aria-label="退出登录" title="退出登录">${icon("logout")}</button></div></div></aside><main class="main"><header class="topbar"><div class="breadcrumbs"><button class="icon-button mobile-toggle" data-action="menu" aria-label="展开导航">${icon("menu")}</button><span>管理控制台</span><span>/</span><strong id="breadcrumb"></strong></div><div class="topbar-right"><span class="health" id="connection-state">已安全登录</span><span class="date-label">${escape(new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric" }))}</span><span class="avatar" aria-label="管理员">AD</span></div></header><div class="content"><div class="page-heading"><div><div class="eyebrow" id="eyebrow"></div><h1 id="page-title"></h1><p class="subtitle" id="subtitle"></p></div><div class="heading-actions"><button class="button" data-action="refresh">${icon("refresh")}刷新数据</button><button class="button primary" data-action="goto-users">${icon("users")}管理用户</button></div></div><div id="error" role="alert"></div><div id="view-content">${empty("正在获取数据…")}</div><footer class="footer"><span>© ${new Date().getFullYear()} Praxis · Turn intent into action.</span><span>管理控制台 · 所有数据来自当前服务</span></footer></div></main></div>`;
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
  document.querySelector("#eyebrow").textContent = views[state.view][2];
  document.querySelector('[data-action="goto-users"]').hidden =
    state.view === "users";
}
function metrics() {
  const o = state.overview;
  const cards = [
    [
      "注册用户",
      o.users,
      "users",
      `${number(o.users - o.disabledUsers)} 个正常账号`,
      "已注册",
    ],
    ["有效登录设备", o.activeDevices, "device", "按用户与设备去重", "会话有效"],
    ["云端数据", o.entities, "data", "未删除的同步数据对象", "全域同步"],
    [
      "今日同步写入",
      o.todayOperations,
      "sync",
      "UTC 当日已接收的操作批次",
      "实时统计",
    ],
  ];
  return `<div class="section-kicker">${icon("clock")}截至 ${escape(date(o.updatedAt))}</div><div class="metrics">${cards.map(([title, value, i, foot, pill]) => `<article class="metric"><div class="metric-top">${title}<span class="metric-icon">${icon(i)}</span></div><div class="metric-value">${number(value)}</div><div class="metric-foot"><span class="pill">${pill}</span>${escape(foot)}</div></article>`).join("")}</div>`;
}
function trend() {
  const daily = state.overview.daily;
  const max = Math.max(4, ...daily.map((day) => day.count));
  const points = daily.map((day, index) => [
    43 + index * 36.3,
    163 - (day.count / max) * 130,
  ]);
  const line = points.map((point) => point.join(",")).join(" ");
  return `<section class="panel"><div class="panel-head"><div><h2>同步活动趋势</h2><p>每日成功接收的同步操作批次</p></div><span class="period-label">最近 14 天</span></div><div class="chart-legend"><span></span>同步写入</div><svg class="trend-chart" viewBox="0 0 550 200" role="img" aria-label="最近十四天同步写入趋势，共 ${number(daily.reduce((sum, day) => sum + day.count, 0))} 次">${[0, 1, 2, 3, 4].map((index) => `<line class="trend-grid" x1="43" x2="515" y1="${33 + index * 32.5}" y2="${33 + index * 32.5}"/><text x="33" y="${37 + index * 32.5}" text-anchor="end">${Math.round((max * (4 - index)) / 4)}</text>`).join("")}<polygon class="trend-area" points="43,163 ${line} 515,163"/><polyline class="trend-line" points="${line}"/>${daily.map((day, index) => (index % 3 === 0 || index === 13 ? `<text x="${43 + index * 36.3}" y="187" text-anchor="middle">${day.day.slice(5).replace("-", "/")}</text>` : "")).join("")}${points.map((point, index) => `<circle cx="${point[0]}" cy="${point[1]}" r="3" fill="#59a5b4"><title>${daily[index].day}：${daily[index].count} 次</title></circle>`).join("")}</svg><p class="chart-note">按 UTC 自然日统计 · 不包含拉取请求</p></section>`;
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
function distribution() {
  const o = state.overview;
  return `<section class="panel"><div class="panel-head"><div><h2>数据分布</h2><p>按业务对象类型统计</p></div>${icon("data")}</div><div class="distribution"><div class="distribution-top"><strong>${number(o.entities)}</strong><span>个云端数据对象</span></div>${o.kinds.length ? kindRows(o.kinds, 4) : empty("暂无同步数据", "用户完成首次同步后将在这里显示。")}</div></section>`;
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
  return `${metrics()}<div class="inline-notice">统计仅展示数据数量与类型。同步写入指服务器已接收的操作批次；有效登录设备不等同于当前在线设备。</div><div class="sync-kind-grid">${o.kinds.map((item) => `<div class="panel sync-kind"><span>${escape(kindNames[item.kind] || item.kind)}</span><strong>${number(item.count)}</strong></div>`).join("") || `<div class="panel">${empty("暂无同步数据")}</div>`}</div><div class="chart-grid">${trend()}<section class="panel"><div class="panel-head"><h2>同步累计</h2>${icon("sync")}</div><div class="sync-total"><strong>${number(o.operations)}</strong>已接收操作批次<br><br>涵盖任务、项目、习惯、安排、记录等全域对象。<br>已删除的数据对象不计入云端数据总量。</div></section></div>`;
}
function auditView() {
  const result = state.audit;
  return `<div class="inline-notice">账号状态变更、设备登录撤销与管理员登录会记录在这里。管理操作与审计记录在同一事务内保存。</div><section class="panel table-panel"><div class="panel-head"><div><h2>操作记录</h2><p>按操作发生时间倒序排列</p></div>${icon("log")}</div>${result.entries.length ? `<div class="table-scroll"><table><thead><tr><th>操作</th><th>目标账号</th><th>操作说明</th><th>时间</th></tr></thead><tbody>${result.entries.map((entry) => `<tr><td><span class="user-name">${escape(actionNames[entry.action] || entry.action)}</span></td><td>${escape(entry.email || entry.targetId || "管理控制台")}</td><td>${escape(entry.reason)}</td><td>${escape(date(entry.createdAt))}</td></tr>`).join("")}</tbody></table></div>` : empty("暂无操作记录")}${pagination(result)}</section>`;
}
function systemView() {
  const s = state.system;
  const rows = [
    ["服务名称", s.service],
    ["服务状态", "正常运行"],
    ["同步协议", `v${s.protocolVersion}`],
    [
      "本次运行",
      `${number(Math.floor(s.uptimeSeconds / 3600))} 小时 ${Math.floor(s.uptimeSeconds / 60) % 60} 分钟`,
    ],
    [
      "数据库大小",
      `${(s.databaseBytes / 1024 / 1024).toFixed(2)} MB（不含 WAL）`,
    ],
    ["Node.js", s.nodeVersion],
    ["固定配对凭据", `${s.configuredDevices} 个`],
    ["检查时间", date(s.checkedAt)],
  ];
  return `<div class="system-grid"><section class="panel"><div class="panel-head"><h2>服务运行信息</h2>${icon("device")}</div><dl class="system-body">${rows.map(([label, value]) => `<div class="system-row"><dt>${escape(label)}</dt><dd>${escape(value)}</dd></div>`).join("")}</dl></section><section class="panel"><div class="panel-head"><h2>访问与会话</h2>${icon("shield")}</div><div class="system-body"><div class="system-row"><dt>管理员会话</dt><dd>${s.administratorSessionHours} 小时</dd></div><div class="system-row"><dt>Cookie 保护</dt><dd>HttpOnly · SameSite=Strict${s.secureCookies ? " · Secure" : ""}</dd></div><div class="system-copy"><strong>独立管理员权限</strong>普通应用账号无法访问此控制台。管理员密钥在服务配置中维护，轮换后旧管理会话立即失效。<strong>账号禁用</strong>禁用后撤销该账号的全部登录，阻止新的登录和同步。重新启用后，用户需要重新登录。<strong>数据范围</strong>后台展示账号信息及同步数据统计。用户任务正文、记录内容与密码不会在此展示。</div></div></section><section class="panel"><div class="panel-head"><h2>同步服务代次</h2>${icon("sync")}</div><div class="system-body"><p class="mono system-copy">${escape(s.generation)}</p><p class="subtitle">服务重启后代次会更新，客户端按现有同步协议重新校验。</p></div></section></div>`;
}
function renderView() {
  const content = document.querySelector("#view-content");
  if (!content) return;
  const focus = document.activeElement?.id === "user-search";
  const start = focus ? document.activeElement.selectionStart : null;
  content.innerHTML =
    state.view === "overview"
      ? `${metrics()}<div class="chart-grid">${trend()}${distribution()}</div>${usersTable(true)}`
      : state.view === "users"
        ? usersTable()
        : state.view === "sync"
          ? syncView()
          : state.view === "audit"
            ? auditView()
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
    let overview, users, audit, system;
    if (state.view === "overview")
      [overview, users] = await Promise.all([api("overview"), api("users")]);
    if (state.view === "users")
      users = await api(
        `users?${new URLSearchParams({ page: String(state.page), q: state.q, status: state.status })}`,
      );
    if (state.view === "sync") overview = await api("overview");
    if (state.view === "audit") audit = await api(`audit?page=${state.page}`);
    if (state.view === "system") system = await api("system");
    if (revision !== state.revision) return;
    if (overview) state.overview = overview;
    if (users) state.users = users;
    if (audit) state.audit = audit;
    if (system) state.system = system;
    renderView();
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
    detailDialog.innerHTML = `<div class="dialog-header"><h2 id="detail-title">用户详情</h2><button class="icon-button" data-action="close-detail" aria-label="关闭">${icon("close")}</button></div><div class="dialog-body">${userIdentity(user)}<div class="system-row"><dt>账号状态</dt><dd>${badge(user)}</dd></div><div class="system-row"><dt>注册时间</dt><dd>${escape(date(user.createdAt))}</dd></div><div class="system-row"><dt>最近登录</dt><dd>${escape(date(user.lastLoginAt))}</dd></div><div class="system-row"><dt>用户 ID</dt><dd class="mono">${escape(user.id)}</dd></div><h3 class="dialog-section-title">云端数据</h3>${kinds.length ? kindRows(kinds, 5) : '<p class="dialog-copy">暂无同步数据</p>'}<h3 class="dialog-section-title">有效登录设备 · ${sessions.length} 台</h3>${sessions.map((session) => `<div class="session-card"><div class="mono">${escape(session.deviceId)}</div><div class="session-card-footer"><span>到期 ${escape(date(session.expiresAt))}</span><button class="text-button" data-action="revoke-device" data-device="${escape(session.deviceId)}">撤销登录</button></div></div>`).join("") || '<p class="dialog-copy">暂无有效登录设备</p>'}</div><div class="dialog-actions"><button class="button" data-action="revoke-all" ${sessions.length ? "" : "disabled"}>撤销全部登录</button><button class="button ${user.disabled ? "primary" : "danger"}" data-action="toggle-status">${user.disabled ? "启用账号" : "禁用账号"}</button></div>`;
  } catch (error) {
    if (detailDialog.open) {
      detailDialog.close();
      toast(error.message);
    }
  }
}
function confirmAction(action, deviceId) {
  const user = state.selected.user;
  const disabling = action === "toggle-status" && !user.disabled;
  const title =
    action === "toggle-status"
      ? user.disabled
        ? "启用账号"
        : "禁用账号"
      : action === "revoke-device"
        ? "撤销设备登录"
        : "撤销全部登录";
  const description =
    action === "toggle-status"
      ? user.disabled
        ? "启用后，用户可重新登录并继续同步。"
        : "将撤销全部登录，并阻止该用户登录和同步。已有数据会保留。"
      : "所选设备需要重新登录才能继续同步，已有数据会保留。";
  state.pending = { id: user.id, action, deviceId, disabled: !user.disabled };
  confirmDialog.innerHTML = `<form id="action-form"><div class="dialog-header"><h2 id="confirm-title">${title}</h2><button type="button" class="icon-button" data-action="close-confirm" aria-label="关闭">${icon("close")}</button></div><div class="dialog-body"><p class="dialog-copy">${escape(user.email)}<br>${description}</p><label for="action-reason" class="field-label">操作原因 <span>（必填，将记入日志）</span></label><textarea id="action-reason" class="form-input" name="reason" rows="3" required maxlength="200" placeholder="请填写本次操作的原因"></textarea><div class="dialog-error" role="alert"></div></div><div class="dialog-actions"><button type="button" class="button" data-action="close-confirm">取消</button><button class="button ${disabling ? "danger" : "primary"}" type="submit">确认${title}</button></div></form>`;
  confirmDialog.showModal();
  document.querySelector("#action-reason").focus();
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
  if (action === "close-detail") detailDialog.close();
  if (action === "close-confirm") confirmDialog.close();
  if (["revoke-device", "revoke-all", "toggle-status"].includes(action))
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
  if (event.target.id === "status-filter") {
    state.status = event.target.value;
    state.page = 1;
    load();
  }
});
document.addEventListener("submit", async (event) => {
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
  try {
    await api(
      `users/${encodeURIComponent(pending.id)}/${pending.action === "toggle-status" ? "status" : "revoke"}`,
      {
        method: "POST",
        body: JSON.stringify({
          reason,
          ...(pending.action === "toggle-status"
            ? { disabled: pending.disabled }
            : pending.deviceId
              ? { deviceId: pending.deviceId }
              : {}),
        }),
      },
    );
    confirmDialog.close();
    toast("操作已完成并记入日志。");
    await Promise.all([openUser(pending.id, false), load()]);
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
