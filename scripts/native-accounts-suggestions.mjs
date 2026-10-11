import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID as uuid } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import net from "node:net";
import { createServer } from "../apps/api/dist/server.js";

const root = resolve(import.meta.dirname, "..");
const data = await mkdtemp(join(root, ".tools/account-qa-"));
const exe = join(data, "Praxis.exe");
await copyFile(
  resolve(
    root,
    process.argv[2] ?? "apps/desktop/src-tauri/target/debug/praxis-desktop.exe",
  ),
  exe,
);
const evidence = join(root, "docs/evidence/accounts-suggestions");
await mkdir(evidence, { recursive: true });
const api = createServer({
  databasePath: join(data, "api.db"),
  devices: [],
  https: {
    key: await readFile(join(root, ".tools/lan/server.key")),
    cert: await readFile(join(root, ".tools/lan/server.crt")),
  },
});
await api.listen({ host: "127.0.0.1", port: 0 });
const apiPort = api.server.address().port,
  baseUrl = `https://127.0.0.1:${apiPort}`,
  caPem = await readFile(join(root, ".tools/lan/ca.crt"), "utf8");
const listener = net.createServer();
await new Promise((r) => listener.listen(0, "127.0.0.1", r));
const debugPort = listener.address().port;
await new Promise((r) => listener.close(r));
let browser, page;
const errors = [],
  checks = [];
const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    PRAXIS_DATA_DIR: join(data, "client"),
    WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${debugPort} --remote-debugging-address=127.0.0.1`,
  },
});
async function connect() {
  for (let i = 0; i < 100; i++)
    try {
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`, {
        timeout: 1000,
      });
      page = browser.contexts()[0].pages()[0];
      await page.locator(".day-period").first().waitFor({ timeout: 1500 });
      page.setDefaultTimeout(15000);
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewportSize({ width: 1300, height: 950 });
      return;
    } catch {
      if (browser) await browser.close().catch(() => {});
      await delay(200);
    }
  throw Error("Test desktop failed to open");
}
const ipc = (name, args = {}) =>
  page.evaluate(
    ({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args),
    { name, args },
  );
const cmd = (action) => ({
  operationId: uuid(),
  occurredAt: new Date().toISOString(),
  action,
});
const taskInput = () => page.getByLabel("任务标题", { exact: true });
async function capture(title) {
  await taskInput().fill(title);
  await taskInput().press("Enter");
  await expect(page.locator(".task-title", { hasText: title })).toBeVisible();
}
async function settings() {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "用户账号", exact: true }),
  ).toBeVisible();
}
const password = "account test password with spaces";
async function authenticate(mode, email, name = "") {
  await settings();
  if (mode === "register")
    await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await page.getByLabel("账号服务地址", { exact: true }).fill(baseUrl);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  if (mode === "register")
    await page.getByLabel("昵称", { exact: true }).fill(name);
  await page.getByText("连接设置", { exact: true }).click();
  await page.getByLabel("服务证书（可选）", { exact: true }).fill(caPem);
  const close = page.waitForEvent("close", { timeout: 20000 });
  await page
    .getByRole("button", {
      name: mode === "register" ? "注册并登录" : "登录账号",
      exact: true,
    })
    .click();
  await close;
  await browser.close().catch(() => {});
  await connect();
}
async function logout() {
  await settings();
  const close = page.waitForEvent("close", { timeout: 20000 });
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await close;
  await browser.close().catch(() => {});
  await connect();
}
try {
  await connect();
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Hong_Kong",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  const task = uuid();
  await ipc("productivity_command", {
    command: cmd({
      type: "task",
      id: task,
      expectedVersion: null,
      title: "建议任务转换验收",
      notes: "这条备注应完整保留",
      projectId: null,
      plan: null,
      deadline: { kind: "date", date },
      followUp: null,
      priority: 2,
      waitingFor: "",
      waitingNote: "",
      labels: [],
    }),
  });
  await page.reload();
  await page.locator(".timeline-attention summary").click();
  await expect(
    page.getByRole("button", {
      name: "转为普通任务：建议任务转换验收",
      exact: true,
    }),
  ).toBeVisible();
  await page.screenshot({ path: join(evidence, "suggestion-before.png") });
  await page
    .getByRole("button", {
      name: "转为普通任务：建议任务转换验收",
      exact: true,
    })
    .click();
  await expect(
    page.locator(".task-item", { hasText: "建议任务转换验收" }),
  ).toBeVisible();
  await expect(
    page.locator(".task-suggestions li[data-task-id='" + task + "']"),
  ).toHaveCount(0);
  const after = (await ipc("productivity_snapshot")).tasks.find(
    (t) => t.id === task,
  );
  expect(after.notes).toBe("这条备注应完整保留");
  expect(after.deadline.date).toBe(date);
  await page.screenshot({ path: join(evidence, "suggestion-after.png") });
  checks.push("建议任务转入普通清单、原 ID/备注/截止时间保留、建议区不重复");
  await settings();
  await page.screenshot({ path: join(evidence, "account-register.png") });
  const emailA = `a-${uuid()}@example.test`,
    emailB = `b-${uuid()}@example.test`;
  await page.getByRole("link", { name: "今日与近期", exact: true }).click();
  await authenticate("register", emailA, "测试用户 A");
  expect((await ipc("account_status")).user.email).toBe(emailA);
  expect((await ipc("productivity_snapshot")).tasks).toEqual([]);
  await capture("用户 A 的私人任务");
  await settings();
  await page.screenshot({ path: join(evidence, "account-logged-in.png") });
  await logout();
  expect((await ipc("account_status")).user).toBeNull();
  expect(
    (await ipc("productivity_snapshot")).tasks.some((t) => t.id === task),
  ).toBe(true);
  expect(
    (await ipc("productivity_snapshot")).tasks.some(
      (t) => t.title === "用户 A 的私人任务",
    ),
  ).toBe(false);
  await authenticate("register", emailB, "测试用户 B");
  expect((await ipc("productivity_snapshot")).tasks).toEqual([]);
  await capture("用户 B 的私人任务");
  await logout();
  await authenticate("login", emailA);
  expect(
    (await ipc("productivity_snapshot")).tasks.map((t) => t.title),
  ).toEqual(["用户 A 的私人任务"]);
  await expect
    .poll(async () => (await ipc("lan_sync_status")).state, { timeout: 15000 })
    .toBe("online");
  await page.screenshot({ path: join(evidence, "account-a-tasks.png") });
  checks.push(
    "真实注册/登录/退出和自动重启；本机、A、B 三个工作空间隔离；A 重新登录恢复数据和同步",
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify({ status: "passed", checks, errors, data }, null, 2),
  );
  console.log(JSON.stringify({ status: "passed", checks }));
} catch (error) {
  await page
    ?.screenshot({ path: join(evidence, "failure.png") })
    .catch(() => {});
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      { status: "failed", message: String(error), checks, errors, data },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser?.close().catch(() => {});
  // This unique copied executable belongs only to this test, including restarted children.
  const literal = exe.replaceAll("'", "''");
  execFileSync(
    "powershell.exe",
    [
      "-NoProfile",
      "-Command",
      `Get-Process | Where-Object { $_.Path -eq '${literal}' } | Stop-Process -Force`,
    ],
    { windowsHide: true, stdio: "ignore" },
  );
  child.kill();
  await api.close();
}
