import { chromium, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, mkdtemp, writeFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID as uuid } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "../apps/api/dist/server.js";
import { DatabaseSync } from "node:sqlite";
const root = resolve(import.meta.dirname, ".."),
  evidence = join(root, "docs/evidence/accounts-suggestions");
await mkdir(evidence, { recursive: true });
const data = await mkdtemp(join(root, ".tools/mobile-account-qa-"));
const api = createServer({
  databasePath: join(data, "api.db"),
  devices: [],
  https: {
    key: await readFile(join(root, ".tools/lan/server.key")),
    cert: await readFile(join(root, ".tools/lan/server.crt")),
  },
});
await api.listen({ host: "127.0.0.1", port: 0 });
const baseUrl = `https://10.0.2.2:${api.server.address().port}`,
  caPem = await readFile(join(root, ".tools/lan/ca.crt"), "utf8");
const adb = (...args) =>
  execFileSync(
    "C:/Users/ltcxl/AppData/Local/Android/Sdk/platform-tools/adb.exe",
    ["-s", "emulator-5554", ...args],
    { encoding: "utf8", windowsHide: true },
  ).trim();
let browser, page;
const errors = [],
  checks = [],
  emails = [
    `android-a-${uuid()}@example.test`,
    `android-b-${uuid()}@example.test`,
  ];
async function connect() {
  for (let i = 0; i < 100; i++)
    try {
      const pid = adb("shell", "pidof", "com.praxis.mobile");
      adb(
        "forward",
        "tcp:9237",
        `localabstract:webview_devtools_remote_${pid}`,
      );
      browser = await chromium.connectOverCDP("http://127.0.0.1:9237", {
        timeout: 1000,
      });
      page = browser.contexts()[0].pages()[0];
      await page.locator(".pm-app").waitFor({ timeout: 2000 });
      page.setDefaultTimeout(15000);
      page.on("pageerror", (e) => errors.push(e.message));
      return;
    } catch {
      await delay(200);
    }
  throw Error("Android app did not open");
}
const native = (method, options = {}) =>
  page.evaluate(
    ({ method, options }) =>
      window.Capacitor.nativePromise("LanSync", method, options),
    { method, options },
  );
const nav = async (name) => {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
  if (
    name === "我的" &&
    (await page.locator(".pm-profile-controls").getAttribute("open")) === null
  )
    await page.locator(".pm-profile-controls > summary").click();
};
async function login(mode, email, name = "") {
  await nav("我的");
  if (mode === "register")
    await page.getByRole("button", { name: "注册账号", exact: true }).click();
  await page.getByLabel("账号服务地址", { exact: true }).fill(baseUrl);
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page
    .getByLabel("密码", { exact: true })
    .fill("android account test password");
  if (mode === "register")
    await page.getByLabel("昵称", { exact: true }).fill(name);
  await page.getByText("连接设置", { exact: true }).click();
  await page.getByLabel("服务证书（可选）", { exact: true }).fill(caPem);
  await native("accountAuthenticate", {
    mode,
    baseUrl,
    email,
    password: "android account test password",
    displayName: name,
    caPem,
  });
  await page.reload();
  await connect();
  await expect
    .poll(async () => (await native("accountStatus")).user?.email, {
      timeout: 15000,
    })
    .toBe(email);
  await expect(page.locator(".pm-main .mx-form > h2")).toHaveCount(0);
  await nav("我的");
  await expect(
    page.getByRole("button", { name: "退出登录", exact: true }),
  ).toBeVisible();
}
async function logout() {
  await nav("我的");
  await native("accountLogout");
  await page.reload();
  await connect();
  await expect
    .poll(async () => (await native("accountStatus")).user, { timeout: 15000 })
    .toBeNull();
  await nav("清单");
}
async function capture(title) {
  await nav("清单");
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByLabel("名称", { exact: true }).fill(title);
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    page.locator(".pm-task-title strong", { hasText: title }),
  ).toBeVisible();
}
try {
  adb("shell", "am", "start", "-n", "com.praxis.mobile/.MainActivity");
  await connect();
  let initial = await native("accountStatus");
  const testAccountIds = new Set();
  for (const name of await readdir(join(root, ".tools"))) {
    if (!name.startsWith("mobile-account-qa-")) continue;
    try {
      const previous = new DatabaseSync(join(root, ".tools", name, "api.db"), {
        readOnly: true,
      });
      try {
        for (const row of previous
          .prepare("SELECT id,email FROM account_users")
          .all())
          if (/^android-[ab]-[a-f0-9-]+@example\.test$/.test(row.email))
            testAccountIds.add(row.id);
      } finally {
        previous.close();
      }
    } catch {
      /* An interrupted setup may not have created a DB. */
    }
  }
  // Recovery is restricted to an explicitly identified account from this test's DB.
  if (
    initial.user &&
    (testAccountIds.has(initial.user.id) ||
      process.argv.includes(`--restore=${initial.user.id}`))
  ) {
    await native("accountLogout");
    await page.reload().catch(() => {});
    await connect();
    initial = await native("accountStatus");
  }
  if (initial.user)
    throw Error(
      "Existing signed-in account: keep it untouched and skip account switching QA",
    );
  await nav("清单");
  const before = await page.locator(".pm-task-title strong").allTextContents();
  await login("register", emails[0], "Android 用户 A");
  await nav("清单");
  await expect(page.locator(".pm-task-title strong")).toHaveCount(0);
  await capture("Android A 私人任务");
  const profileA = await native("status");
  expect(profileA.databaseName).toMatch(/^praxis_[a-f0-9]{64}$/);
  const wrong = await native("request", {
    method: "GET",
    path: "/v1/entities/snapshot?limit=100",
    databaseName: "praxis",
  }).then(
    () => "allowed",
    () => "rejected",
  );
  expect(wrong).toBe("rejected");
  await nav("我的");
  await page.locator(".account-panel").scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(evidence, "android-account.png") });
  await logout();
  expect(await page.locator(".pm-task-title strong").allTextContents()).toEqual(
    before,
  );
  await login("register", emails[1], "Android 用户 B");
  await nav("清单");
  await expect(page.locator(".pm-task-title strong")).toHaveCount(0);
  await capture("Android B 私人任务");
  expect((await native("status")).databaseName).not.toBe(profileA.databaseName);
  await logout();
  await login("login", emails[0]);
  await nav("清单");
  await expect(page.locator(".pm-task-title strong")).toHaveText([
    "Android A 私人任务",
  ]);
  await expect
    .poll(async () => api.inject({ url: "/health" }).then((r) => r.statusCode))
    .toBe(200);
  const owner = (await native("accountStatus")).user.id;
  const cloud = new DatabaseSync(join(data, "api.db"), { readOnly: true });
  try {
    await expect
      .poll(
        () =>
          cloud
            .prepare("SELECT payload FROM sync_entities WHERE owner=?")
            .all(owner)
            .map((row) => JSON.parse(row.payload))
            .filter((e) => e.kind === "task")
            .map((e) => e.data.title),
        { timeout: 20000 },
      )
      .toEqual(["Android A 私人任务"]);
  } finally {
    cloud.close();
  }
  await page.screenshot({ path: join(evidence, "android-account-tasks.png") });
  checks.push(
    "Android 真实注册、登录、退出和 WebView 重载；原本机数据保留；A/B 数据库隔离；重新登录恢复 A；旧数据库请求被原生层拒绝；自动同步成功",
  );
  await logout();
  expect(await page.locator(".pm-task-title strong").allTextContents()).toEqual(
    before,
  );
  expect(errors).toEqual([]);
  await writeFile(
    join(evidence, "mobile-result.json"),
    JSON.stringify({ status: "passed", checks, errors }, null, 2),
  );
  console.log(JSON.stringify({ status: "passed", checks }));
} catch (error) {
  await page
    ?.screenshot({ path: join(evidence, "android-failure.png") })
    .catch(() => {});
  await writeFile(
    join(evidence, "mobile-result.json"),
    JSON.stringify(
      { status: "failed", message: String(error), checks, errors },
      null,
      2,
    ),
  );
  throw error;
} finally {
  if (page) {
    const current = await native("accountStatus").catch(() => null);
    if (current?.user && emails.includes(current.user.email)) {
      await native("accountLogout").catch(() => {});
      await page.reload().catch(() => {});
    }
  }
  await browser?.close().catch(() => {});
  adb("forward", "--remove", "tcp:9237");
  api.server.closeAllConnections();
  await api.close();
}
