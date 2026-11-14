// Actual Tauri + Android WebView clients. Only a fresh directory, QA package and
// project-owned AVD are allowed; no user's installed package or account is used.
import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  copyFile,
  writeFile,
  readFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { createServer as createNetServer } from "node:net";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../apps/api/dist/server.js";
import { aiEnvironment } from "../apps/api/dist/ai.js";

const root = resolve("."),
  evidence = resolve("docs/evidence/remaining-mvp-2026-11-12/native"),
  serial = "emulator-5560",
  packageId = "com.praxis.mobile.qa";
const adbPath =
  "C:/Users/ltcxl/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const adb = (...args) =>
  execFileSync(adbPath, ["-s", serial, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30000,
  }).trim();
if (adb("emu", "avd", "name").split(/\r?\n/)[0].trim() !== "Praxis_P4")
  throw Error("Refusing to operate a non-isolated Android device");
// Reset only the synthetic QA fixture, on the project-created isolated AVD.
if(packageId!=="com.praxis.mobile.qa")throw Error("Refusing to reset a user package");
adb("shell","am","force-stop",packageId);
adb("shell","pm","clear",packageId);
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".scratch/p4-native-")),
  exe = join(data, "Praxis-P4.exe");
await copyFile(resolve(process.env.PRAXIS_DESKTOP_BUILD ?? ".scratch/remaining-built-desktop.exe"), exe);
const cert = await readFile(
    resolve(".scratch/remaining-mvp-device/tls/server.crt"),
    "utf8",
  ),
  key = await readFile(
    resolve(".scratch/remaining-mvp-device/tls/server.key"),
    "utf8",
  );
const ca = await readFile(resolve(".scratch/remaining-mvp-device/tls/ca.crt"),"utf8");
const password = randomBytes(32).toString("base64url"),
  email = `praxis-p4-${randomUUID()}@example.test`,
  emailB = `praxis-p4-${randomUUID()}@example.test`;
const redact = (s) => String(s).replaceAll(password, "[synthetic password]");
const checks = [],
  errors = [];
let stage = "startup",
  desktopBrowser,
  mobileBrowser,
  desktop,
  mobile,
  child,
  api,
  apiPort;
const record = (text) => {
  checks.push(text);
  process.stdout.write(`PASS ${text}\n`);
};
const freePort = () =>
  new Promise((ok, fail) => {
    const server = createNetServer();
    server.on("error", fail);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => ok(port));
    });
  });
const desktopPort = await freePort(),
  mobilePort = await freePort();
const serverOptions = {
  databasePath: join(data, "server.db"),
  devices: [],
  https: { key, cert },
  ai: aiEnvironment(process.env),
};
async function startServer() {
  api = createServer(serverOptions);
  await api.listen({ host: "127.0.0.1", port: apiPort ?? 0 });
  apiPort = api.server.address().port;
}
const ipc = (name, args = {}) =>
  desktop.evaluate(
    ({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args),
    { name, args },
  );
const native = (plugin, method, options = {}) =>
  mobile.evaluate(
    ({ plugin, method, options }) =>
      window.Capacitor.nativePromise(plugin, method, options),
    { plugin, method, options },
  );
const work = () => ipc("productivity_snapshot");
async function mobileTasks() {
  const config = await native("LanSync", "status");
  const rows = await native("CapacitorSQLite", "query", {
    database: config.databaseName,
    statement:
      "SELECT id,version,deleted,data FROM mobile_entities WHERE workspace_id='local' AND kind='task'",
    values: [],
    readonly: false,
  });
  return (rows.values ?? []).map((row) => ({
    ...row,
    data: JSON.parse(row.data),
  }));
}
async function connectDesktop() {
  await desktopBrowser?.close().catch(() => {});
  for (let i = 0; i < 80; i++) {
    try {
      desktopBrowser = await chromium.connectOverCDP(
        `http://127.0.0.1:${desktopPort}`,
        { timeout: 1200 },
      );
      desktop = desktopBrowser
        .contexts()[0]
        .pages()
        .find((p) => !p.url().startsWith("devtools:"));
      await desktop
        .getByRole("region", { name: "个人待办", exact: true })
        .waitFor({ timeout: 1500 });
      desktop.setDefaultTimeout(15000);
      desktop.on("pageerror", (e) => errors.push(`desktop: ${e.message}`));
      return;
    } catch {
      await desktopBrowser?.close().catch(() => {});
      await delay(300);
    }
  }
  throw Error("Isolated Windows client did not open");
}
async function connectMobile() {
  await mobileBrowser?.close().catch(() => {});
  for (let i = 0; i < 70; i++) {
    try {
      const pid = adb("shell", "pidof", packageId);
      adb(
        "forward",
        `tcp:${mobilePort}`,
        `localabstract:webview_devtools_remote_${pid}`,
      );
      mobileBrowser = await chromium.connectOverCDP(
        `http://127.0.0.1:${mobilePort}`,
        { timeout: 1200 },
      );
      mobile = mobileBrowser
        .contexts()[0]
        .pages()
        .find((p) => !p.url().startsWith("devtools:"));
      await mobile.locator(".pm-app").waitFor({ timeout: 1500 });
      mobile.setDefaultTimeout(15000);
      mobile.on("pageerror", (e) => errors.push(`mobile: ${e.message}`));
      const info = await native("App", "getInfo");
      if (info.id !== packageId) throw Error("Unexpected Android package");
      return;
    } catch {
      await mobileBrowser?.close().catch(() => {});
      await delay(300);
    }
  }
  throw Error("Isolated Android QA WebView did not open");
}
async function goHome(page, mode) {
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", {
      name: mode === "desktop" ? "我的待办" : "待办",
      exact: true,
    })
    .click();
}
async function settings(page, mode) {
  if (mode === "desktop")
    await page.getByRole("button", { name: "设置", exact: true }).click();
  else {
    await page.getByRole("button", { name: "打开菜单", exact: true }).click();
    await page
      .getByRole("dialog", { name: "侧边菜单", exact: true })
      .getByRole("button", { name: "我的", exact: true })
      .click();
  }
  await expect(page.locator(".account-panel")).toBeVisible();
  if(mode==="mobile"){
    const details=page.locator(".account-panel details").filter({has:page.getByText("账户与登录设置",{exact:true})});
    if(await details.getAttribute("open")===null)await details.getByText("账户与登录设置",{exact:true}).click();
  }
}
async function authenticate(mode, kind, userEmail) {
  const page = mode === "desktop" ? desktop : mobile;
  await settings(page, mode);
  if (kind === "register")
    await page.getByRole("button", { name: "注册账号", exact: true }).click();
  const form = page.getByRole("form", { name: "用户登录与注册", exact: true });
  await form.getByText("高级连接设置", { exact: true }).click();
  await form
    .getByLabel("账号服务地址", { exact: true })
    .fill(`https://127.0.0.1:${apiPort}`);
  await form.getByLabel("服务证书（可选）", { exact: true }).fill(ca);
  await form.getByLabel("邮箱", { exact: true }).fill(userEmail);
  await form.getByLabel("密码", { exact: true }).fill(password);
  if (kind === "register")
    await form.getByLabel("昵称", { exact: true }).fill("隔离验收账号");
  const closed = mode === "desktop" ? page.waitForEvent("close",{timeout:30000}).catch(()=>{}) : null;
  await form
    .getByRole("button", {
      name: kind === "register" ? "注册并登录" : "登录账号",
      exact: true,
    })
    .click();
  if (mode === "desktop") {
    await closed;
    await connectDesktop();
  } else {
    await expect
      .poll(
        async () => {
          try {
            return (await native("LanSync", "accountStatus")).user?.email;
          } catch {
            return null;
          }
        },
        { timeout: 30000 },
      )
      .toBe(userEmail);
    await expect(
      mobile.getByRole("region", { name: "个人待办", exact: true }),
    ).toBeVisible();
  }
  const status =
    mode === "desktop"
      ? await ipc("account_status")
      : await native("LanSync", "accountStatus");
  expect(status.user.email).toBe(userEmail);
}
async function logoutMobile() {
  await settings(mobile, "mobile");
  await mobile.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect
    .poll(
      async () => {
        try {
          return (await native("LanSync", "accountStatus")).user;
        } catch {
          return "reload";
        }
      },
      { timeout: 30000 },
    )
    .toBeNull();
  await expect(
    mobile.getByRole("region", { name: "个人待办", exact: true }),
  ).toBeVisible();
}
async function createProject(page, name) {
  await page
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  const list = page.getByRole("region", { name: "个人项目列表", exact: true });
  await list.getByRole("button", { name: "新建项目", exact: true }).click();
  const form = page.getByRole("form", { name: "项目基本信息", exact: true });
  await form.getByLabel("项目名称", { exact: true }).fill(name);
  await form.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByRole("heading", { name, exact: true })).toBeVisible();
}
async function addTask(page, title, project = false) {
  const region = page.getByRole("region", {
    name: project ? "项目任务" : "个人待办",
    exact: true,
  });
  const input = region.getByRole("textbox", {
    name: project ? "项目任务标题" : "新任务标题",
    exact: true,
  });
  await expect(input).toBeEnabled();
  await input.fill(title);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(
    region.getByRole("button", { name: title, exact: true }),
  ).toBeVisible();
}
const home = (page) =>
  page.getByRole("region", { name: "个人待办", exact: true });
const row = (page, title) =>
  home(page)
    .locator(".personal-todo-row")
    .filter({ has: page.getByRole("button", { name: title, exact: true }) });
async function waitMobileTask(title) {
  await expect
    .poll(
      async () => {
        try {
          return (await mobileTasks()).find(
            (t) => !t.deleted && t.data.title === title,
          )?.id;
        } catch {
          return undefined;
        }
      },
      { timeout: 60000, intervals: [1000, 2000] },
    )
    .toBeTruthy();
}
async function waitDesktopTask(title) {
  await expect
    .poll(
      async () => {
        try {
          return (await work()).tasks.find((t) => t.title === title)?.id;
        } catch {
          return undefined;
        }
      },
      { timeout: 60000, intervals: [1000, 2000] },
    )
    .toBeTruthy();
}
async function shot(name) {
  await desktop.screenshot({ path: join(evidence, `desktop-${name}.png`) });
  await mobile.screenshot({ path: join(evidence, `android-${name}.png`) });
}
try {
  await startServer();
  adb("reverse", `tcp:${apiPort}`, `tcp:${apiPort}`);
  child = spawn(exe, [], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      PRAXIS_DATA_DIR: join(data, "desktop"),
      WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
      WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${desktopPort} --remote-debugging-address=127.0.0.1`,
    },
  });
  adb(
    "shell",
    "am",
    "start",
    "-n",
    `${packageId}/com.praxis.mobile.MainActivity`,
  );
  await connectDesktop();
  await connectMobile();
  expect((await ipc("account_status")).user).toBeNull();
  expect((await native("LanSync", "accountStatus")).user).toBeNull();
  await expect(
    desktop
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button"),
  ).toHaveCount(2);
  await expect(
    mobile
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button"),
  ).toHaveCount(2);
  record(
    "actual Tauri and isolated Android package start with two primary destinations and fresh guest storage",
  );
  stage = "guest-core";
  await createProject(desktop, "隔离个人项目");
  await addTask(desktop, "隔离首项任务", true);
  const guestTask = (await work()).tasks.find(
    (t) => t.title === "隔离首项任务",
  );
  expect(guestTask.plan).toBeNull();
  await desktop
    .getByRole("region", { name: "项目任务", exact: true })
    .getByRole("combobox", { name: "任务状态：隔离首项任务", exact: true })
    .selectOption("completed");
  await expect(
    desktop.getByLabel("项目任务进度", { exact: true }),
  ).toContainText("1 / 1");
  await goHome(desktop, "desktop");
  await expect(
    desktop.getByRole("region", { name: "个人成长", exact: true }),
  ).toContainText("总计 10 XP");
  await home(desktop)
    .locator(".personal-todo-completed > summary")
    .filter({ hasText: /^已完成/ })
    .click();
  await row(desktop, "隔离首项任务")
    .getByRole("button", { name: "删除：隔离首项任务", exact: true })
    .click();
  await expect(
    desktop.getByRole("region", { name: "个人成长", exact: true }),
  ).toContainText("总计 0 XP");
  await home(desktop)
    .getByRole("button", { name: "撤销上次操作", exact: true })
    .click();
  await expect(
    desktop.getByRole("region", { name: "个人成长", exact: true }),
  ).toContainText("总计 10 XP");
  expect((await work()).tasks.find((t) => t.id === guestTask.id)?.status).toBe(
    "completed",
  );
  record(
    "actual guest project/task identity, progress, completion XP, deletion and checked undo round-trip",
  );
  stage = "backup";
  await settings(desktop, "desktop");
  await desktop.getByRole("button", { name: "立即备份", exact: true }).click();
  await expect(desktop.getByText("备份已创建", { exact: true })).toBeVisible();
  const backup = (await ipc("backup_list")).find((b) =>
    b.name.includes("-manual-"),
  );
  expect(backup.path.toLowerCase()).toContain(data.toLowerCase());
  await goHome(desktop, "desktop");
  await addTask(desktop, "备份后临时内容");
  await settings(desktop, "desktop");
  await desktop
    .locator(".backup-list li")
    .filter({ hasText: "手动备份" })
    .first()
    .getByRole("button", { name: "恢复", exact: true })
    .click();
  await desktop.getByRole("button", { name: "确认恢复", exact: true }).click();
  await expect(
    desktop.getByText(
      "恢复副本已验证，重新打开应用后生效；当前数据不会被覆盖。",
      { exact: true },
    ),
  ).toBeVisible();
  await ipc("account_restart").catch(() => {});
  await delay(500);
  await connectDesktop();
  expect((await work()).tasks.some((t) => t.title === "备份后临时内容")).toBe(
    false,
  );
  expect((await work()).tasks.find((t) => t.id === guestTask.id)?.status).toBe(
    "completed",
  );
  record(
    "actual desktop UI creates/validates backup, restarts into a restored copy and keeps the original guest identity/completion",
  );
  stage = "same-account";
  await authenticate("desktop", "register", email);
  await authenticate("mobile", "login", email);
  expect((await work()).tasks.some((t) => t.id === guestTask.id)).toBe(false);
  await createProject(desktop, "同账号项目");
  await addTask(desktop, "双端同一任务", true);
  const shared = (await work()).tasks.find((t) => t.title === "双端同一任务");
  await waitMobileTask(shared.title);
  await goHome(desktop, "desktop");
  await goHome(mobile, "mobile");
  await expect(
    home(mobile).getByRole("button", { name: shared.title, exact: true }),
  ).toBeVisible();
  expect(
    (await mobileTasks()).find((t) => t.data.title === shared.title)?.id,
  ).toBe(shared.id);
  await row(mobile, shared.title)
    .getByRole("combobox")
    .selectOption("in_progress");
  await expect
    .poll(
      async () => (await work()).tasks.find((t) => t.id === shared.id)?.status,
      { timeout: 60000, intervals: [1000, 2000] },
    )
    .toBe("in_progress");
  await row(mobile, shared.title)
    .getByRole("combobox")
    .selectOption("completed");
  await expect
    .poll(
      async () => (await work()).tasks.find((t) => t.id === shared.id)?.status,
      { timeout: 60000, intervals: [1000, 2000] },
    )
    .toBe("completed");
  await goHome(desktop, "desktop");
  await expect(
    desktop.getByRole("region", { name: "个人成长", exact: true }),
  ).toContainText("总计 10 XP");
  record(
    "actual HTTPS account registration/login and cross-device same-ID state/progress/XP synchronization",
  );
  stage = "offline";
  await api.close();
  api = null;
  await addTask(mobile, "断网保留的独立任务");
  const offline = (await mobileTasks()).find(
    (t) => t.data.title === "断网保留的独立任务",
  );
  expect((await work()).tasks.some((t) => t.id === offline.id)).toBe(false);
  await startServer();
  await waitDesktopTask("断网保留的独立任务");
  expect((await work()).tasks.filter((t) => t.id === offline.id)).toHaveLength(
    1,
  );
  record(
    "offline Android save survives HTTPS server downtime and synchronizes once after reconnect",
  );
  stage = "agent";
  await desktop
    .getByRole("navigation", { name: "主导航", exact: true })
    .getByRole("button", { name: "项目", exact: true })
    .click();
  await desktop
    .getByRole("region", { name: "个人项目列表", exact: true })
    .getByRole("button", { name: /^同账号项目/ })
    .click();
  await desktop
    .getByRole("button", { name: "✦ 拆成步骤", exact: true })
    .click();
  let panel = desktop.getByRole("dialog", { name: "行动助手", exact: true });
  await expect(
    panel.getByRole("button", { name: "生成任务草稿", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await panel
    .getByLabel("项目目标", { exact: true })
    .fill("为个人读书笔记整理一个简单页面，给出3个小步骤，不要重复已有任务。");
  const countBefore = (await work()).tasks.length;
  await panel
    .getByRole("button", { name: "生成任务草稿", exact: true })
    .click();
  await expect(
    panel.getByRole("region", { name: "AI生成内容", exact: true }),
  ).toBeVisible({ timeout: 120000 });
  expect((await work()).tasks.length).toBe(countBefore);
  const selected = panel.getByRole("checkbox", {
    name: "保留此项",
    exact: true,
  });
  const n = await selected.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 1; i < n; i++) await selected.nth(i).uncheck();
  await panel
    .getByLabel("任务标题", { exact: true })
    .first()
    .fill("隔离AI确认任务");
  await panel
    .getByLabel("说明（可选）", { exact: true })
    .first()
    .fill("用户修改的说明，真实模型草稿一次确认");
  await panel
    .getByLabel("截止日期（可选）", { exact: true })
    .first()
    .fill("2026-12-10");
  await panel
    .getByRole("button", { name: "确认创建 1 项任务", exact: true })
    .click();
  await expect(panel.getByText(/已经采用/)).toBeVisible({ timeout: 30000 });
  expect((await work()).tasks.length).toBe(countBefore + 1);
  await panel
    .getByRole("button", { name: "关闭行动助手", exact: true })
    .click();
  await waitMobileTask("隔离AI确认任务");
  const adopted = (await mobileTasks()).find(
    (t) => t.data.title === "隔离AI确认任务",
  );
  expect(adopted.data.notes).toContain("用户修改的说明");
  expect(adopted.data.dueDate).toBe("2026-12-10");
  await goHome(mobile, "mobile");
  const beforeReadOnly = (await mobileTasks())
    .filter((t) => !t.deleted)
    .map((t) => [t.id, t.version])
    .sort();
  await home(mobile)
    .getByRole("button", { name: "下一步建议", exact: true })
    .click();
  panel = mobile.getByRole("dialog", { name: "行动助手", exact: true });
  await expect(
    panel.getByRole("region", { name: "系统下一步建议", exact: true }),
  ).toBeVisible();
  expect(
    await panel
      .getByRole("region", { name: "系统下一步建议", exact: true })
      .getByRole("listitem")
      .count(),
  ).toBeLessThanOrEqual(3);
  await expect(
    panel.getByRole("button", { name: "请 AI 解释下一步", exact: true }),
  ).toBeEnabled({ timeout: 30000 });
  await panel
    .getByRole("button", { name: "请 AI 解释下一步", exact: true })
    .click();
  await expect(
    panel.getByRole("heading", { name: "AI 解释", exact: true }),
  ).toBeVisible({ timeout: 120000 });
  expect(await panel.getByRole("button", { name: /确认创建/ }).count()).toBe(0);
  expect(
    (await mobileTasks())
      .filter((t) => !t.deleted)
      .map((t) => [t.id, t.version])
      .sort(),
  ).toEqual(beforeReadOnly);
  await panel
    .getByRole("button", { name: "关闭行动助手", exact: true })
    .click();
  record(
    "actual model generation stays draft until one confirmation; edited fields sync; Android AI next-step explanation remains task-read-only",
  );
  stage = "restart-and-isolation";
  adb("shell", "am", "force-stop", packageId);
  adb(
    "shell",
    "am",
    "start",
    "-n",
    `${packageId}/com.praxis.mobile.MainActivity`,
  );
  await connectMobile();
  await waitMobileTask("隔离AI确认任务");
  expect(
    (await mobileTasks()).find((t) => t.id === shared.id)?.data.status,
  ).toBe("completed");
  await logoutMobile();
  await authenticate("mobile", "register", emailB);
  expect(
    (await mobileTasks()).some(
      (t) => t.id === shared.id || t.id === adopted.id,
    ),
  ).toBe(false);
  await logoutMobile();
  await authenticate("mobile", "login", email);
  await waitMobileTask("隔离AI确认任务");
  record(
    "actual Android process restart and second-account isolation retain the first account's synchronized tasks",
  );
  await goHome(desktop, "desktop");
  await goHome(mobile, "mobile");
  await shot("final");
  await writeFile(
    join(evidence, "results.json"),
    JSON.stringify(
      {
        passed: true,
        completedAt: new Date().toISOString(),
        runtime:
          "real Tauri WebView2 + Android 17/API 37 isolated emulator; local HTTPS account/entity service; real configured model",
        device: { serial, avd: "Praxis_P4", packageId },
        syntheticDataOnly: true,
        checks,
        errors,
        dataDirectory: data,
        limits: [
          "Android emulator, not physical handset",
          "System IME handwriting/Chinese candidate selection is not replaced by Playwright text entry",
        ],
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    JSON.stringify({ passed: true, checks: checks.length, errors }, null, 2) +
      "\n",
  );
} catch (error) {
  for (const [name, page] of [
    ["desktop", desktop],
    ["android", mobile],
  ])
    if (page) {
      await page
        .screenshot({ path: join(evidence, `${name}-failure.png`) })
        .catch(() => {});
      await writeFile(
        join(evidence, `${name}-failure-body.txt`),
        redact(
          await page
            .locator("body")
            .innerText()
            .catch(() => ""),
        ),
      );
    }
  await writeFile(
    join(evidence, "failure.json"),
    JSON.stringify(
      {
        passed: false,
        stage,
        error: redact(error?.stack ?? error),
        checks,
        errors,
        dataDirectory: data,
      },
      null,
      2,
    ),
  );
  process.stderr.write(redact(error?.stack ?? error) + "\n");
  process.exitCode = 1;
} finally {
  await desktopBrowser?.close().catch(() => {});
  await mobileBrowser?.close().catch(() => {});
  await api?.close().catch(() => {});
  child?.kill();
  // Account restarts can create a replacement process; only this unique copied executable is stopped.
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq '${exe.replaceAll("'", "''")}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {}
  try {
    adb("forward", "--remove", `tcp:${mobilePort}`);
    adb("reverse", "--remove", `tcp:${apiPort}`);
  } catch {}
}
