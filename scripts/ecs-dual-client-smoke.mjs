// Uses the real Windows and Android clients against the deployed cloud service.
// Test credentials stay in memory; business writes go through client UI only.
import { chromium, expect } from "@playwright/test";
import { spawn, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(import.meta.dirname, "..");
const baseUrl =
  process.env.PRAXIS_CLOUD_BASE_URL ?? "https://todo.frostraven05.com";
const quickTaskSmoke = process.env.PRAXIS_QUICK_TASK_SMOKE === "1";
const evidence = process.env.PRAXIS_CLOUD_EVIDENCE_DIR
  ? resolve(process.env.PRAXIS_CLOUD_EVIDENCE_DIR)
  : join(
      root,
      quickTaskSmoke
        ? "docs/evidence/mobile-quick-task"
        : "docs/evidence/ecs-clients",
    );
const data = await mkdtemp(join(root, ".tools/ecs-client-qa-"));
const exe = join(data, "Praxis.exe");
await mkdir(evidence, { recursive: true });
await copyFile(
  resolve(
    process.env.PRAXIS_DESKTOP_BUILD ??
      join(root, ".tools/releases/domain-https/Praxis.exe"),
  ),
  exe,
);
const adbPath =
  "C:/Users/ltcxl/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const adb = (...args) =>
  execFileSync(adbPath, ["-s", "emulator-5554", ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const desktopPort = 9242,
  mobilePort = 9243;
const email = `ecs-${randomUUID()}@example.invalid`;
const password = randomBytes(32).toString("base64url");
const stamp = `云同步验收 ${Date.now()}`;
const checks = [],
  errors = [];
let db, mb, desktop, mobile, mobileGuestTitles;
let mobileTestAccount = false;
let hardwareKeyboard;
let handwriting;
const child = spawn(exe, [], {
  cwd: root,
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    PRAXIS_DATA_DIR: join(data, "client"),
    WEBVIEW2_USER_DATA_FOLDER: join(data, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${desktopPort} --remote-debugging-address=127.0.0.1`,
  },
});
const ipc = (name, args = {}) =>
  desktop.evaluate(
    ({ name, args }) => window.__TAURI_INTERNALS__.invoke(name, args),
    { name, args },
  );
const native = (method, options = {}) =>
  mobile.evaluate(
    ({ method, options }) =>
      window.Capacitor.nativePromise("LanSync", method, options),
    { method, options },
  );
async function connectDesktop() {
  await db?.close().catch(() => {});
  for (let i = 0; i < 100; i++) {
    try {
      db = await chromium.connectOverCDP(`http://127.0.0.1:${desktopPort}`, {
        timeout: 1000,
      });
      desktop = db
        .contexts()[0]
        .pages()
        .find((p) => !p.url().startsWith("devtools:"));
      await desktop.locator(".day-period").first().waitFor({ timeout: 2000 });
      desktop.setDefaultTimeout(15000);
      desktop.on("pageerror", (e) => errors.push(e.message));
      return;
    } catch {
      await db?.close().catch(() => {});
      await delay(300);
    }
  }
  throw Error("Windows client did not start");
}
async function connectMobile() {
  await mb?.close().catch(() => {});
  for (let i = 0; i < 60; i++) {
    try {
      const pid = adb("shell", "pidof", "com.praxis.mobile");
      adb(
        "forward",
        `tcp:${mobilePort}`,
        `localabstract:webview_devtools_remote_${pid}`,
      );
      mb = await chromium.connectOverCDP(`http://127.0.0.1:${mobilePort}`, {
        timeout: 1500,
      });
      mobile = mb
        .contexts()[0]
        .pages()
        .find((p) => !p.url().startsWith("devtools:"));
      await mobile.locator(".pm-app").waitFor({ timeout: 2500 });
      mobile.setDefaultTimeout(15000);
      mobile.on("pageerror", (e) => errors.push(e.message));
      return;
    } catch {
      await mb?.close().catch(() => {});
      await delay(300);
    }
  }
  throw Error("Android client did not start");
}
async function desktopSettings() {
  await desktop.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    desktop.getByRole("heading", { name: "用户账号", exact: true }),
  ).toBeVisible();
}
async function desktopAuth(mode) {
  await desktopSettings();
  if (mode === "register")
    await desktop
      .getByRole("button", { name: "注册账号", exact: true })
      .click();
  await expect(desktop.getByLabel("账号服务地址", { exact: true })).toHaveValue(
    baseUrl,
  );
  await desktop.getByLabel("邮箱", { exact: true }).fill(email);
  await desktop.getByLabel("密码", { exact: true }).fill(password);
  if (mode === "register")
    await desktop.getByLabel("昵称", { exact: true }).fill("云端双端验收");
  const closed = desktop.waitForEvent("close", { timeout: 30000 });
  await desktop
    .getByRole("button", {
      name: mode === "register" ? "注册并登录" : "登录账号",
      exact: true,
    })
    .click();
  await closed;
  await connectDesktop();
  expect((await ipc("account_status")).user.email).toBe(email);
  expect((await ipc("account_status")).baseUrl).toBe(baseUrl);
}
async function desktopLogout() {
  await desktopSettings();
  const closed = desktop.waitForEvent("close", { timeout: 30000 });
  await desktop.getByRole("button", { name: "退出登录", exact: true }).click();
  await closed;
  await connectDesktop();
}
async function mobileNav(name) {
  await mobile
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
  if (name === "我的") {
    const details = mobile.locator(".pm-profile-controls");
    if (
      (await details.count()) &&
      (await details.getAttribute("open")) === null
    )
      await details.locator("summary").first().click();
  }
}
const desktopEntities = () => ipc("lan_entity_snapshot");
const findTask = async (title) =>
  (await desktopEntities()).find(
    (e) => e.kind === "task" && e.data.title === title && !e.deleted,
  );
async function restartMobile() {
  await mb?.close();
  mb = null;
  adb("shell", "am", "force-stop", "com.praxis.mobile");
  adb("shell", "am", "start", "-n", "com.praxis.mobile/.MainActivity");
  await connectMobile();
}
try {
  console.log("Starting real native clients");
  if (quickTaskSmoke) {
    hardwareKeyboard = adb(
      "shell",
      "settings",
      "get",
      "secure",
      "show_ime_with_hard_keyboard",
    );
    adb(
      "shell",
      "settings",
      "put",
      "secure",
      "show_ime_with_hard_keyboard",
      "1",
    );
    handwriting = adb(
      "shell",
      "settings",
      "get",
      "secure",
      "stylus_handwriting_enabled",
    );
    adb(
      "shell",
      "settings",
      "put",
      "secure",
      "stylus_handwriting_enabled",
      "0",
    );
    adb("shell", "am", "force-stop", "com.praxis.mobile");
  }
  adb("shell", "am", "start", "-n", "com.praxis.mobile/.MainActivity");
  await connectDesktop();
  await connectMobile();
  const initial = await native("accountStatus");
  if (initial.user)
    throw Error(
      "Android already has a signed-in account; refusing to replace it during verification",
    );
  expect(initial.baseUrl).toBe(baseUrl);
  await mobileNav("清单");
  mobileGuestTitles = await mobile
    .locator(".pm-task-title strong")
    .allTextContents();
  expect((await ipc("account_status")).baseUrl).toBe(baseUrl);
  checks.push(
    "Both native clients default to the configured HTTPS endpoint without a custom CA",
  );
  await desktopAuth("register");
  await desktopLogout();
  await desktopAuth("login");
  checks.push(
    "Windows UI registration, logout and login through real HTTPS succeeded",
  );
  await mobileNav("我的");
  await expect(mobile.getByLabel("账号服务地址", { exact: true })).toHaveValue(
    baseUrl,
  );
  await mobile.getByLabel("邮箱", { exact: true }).fill(email);
  await mobile.getByLabel("密码", { exact: true }).fill(password);
  mobileTestAccount = true;
  await mobile.getByRole("button", { name: "登录账号", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await native("accountStatus").catch(() => null))?.user?.email,
      {
        timeout: 30000,
      },
    )
    .toBe(email);
  await mobile.locator(".pm-app").waitFor();
  checks.push(
    "Android UI logged into the same cloud account with the system certificate trust store",
  );
  console.log("Both clients signed into the same cloud account");

  const desktopTitle = stamp + " 桌面创建";
  await desktop.getByLabel("任务标题", { exact: true }).fill(desktopTitle);
  await desktop.getByLabel("任务标题", { exact: true }).press("Enter");
  await expect(
    desktop.locator(".task-title", { hasText: desktopTitle }),
  ).toBeVisible();
  await mobileNav("清单");
  await expect(
    mobile.locator(".pm-task-title strong", { hasText: desktopTitle }),
  ).toHaveCount(1, { timeout: 90000 });
  checks.push(
    "Windows UI task automatically appeared exactly once in Android UI through the ECS",
  );

  await mobile.getByRole("button", { name: "新建任务", exact: true }).click();
  const mobileTitle = stamp + " 手机创建";
  if (quickTaskSmoke) {
    const panel = mobile.getByRole("dialog", {
      name: "快速添加任务",
      exact: true,
    });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "添加", exact: true }),
    ).toBeDisabled();
    await expect(
      panel.getByRole("button", { name: "今天", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect(panel.getByLabel("名称", { exact: true })).toBeFocused();
    await expect(panel.getByLabel("状态", { exact: true })).toHaveCount(0);
    await mobile.screenshot({ path: join(evidence, "quick-add.png") });
    const screenshot = execFileSync(
      adbPath,
      ["-s", "emulator-5554", "exec-out", "screencap", "-p"],
      { windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    );
    await writeFile(join(data, "quick-add-device.png"), screenshot);
    const geometry = await panel.evaluate((el) => {
      const add = el.querySelector(".pm-entry-submit").getBoundingClientRect();
      const view = window.visualViewport;
      return {
        addTop: add.top,
        addBottom: add.bottom,
        viewportTop: view?.offsetTop ?? 0,
        viewportBottom: (view?.offsetTop ?? 0) + (view?.height ?? innerHeight),
        pageWidth: innerWidth,
        contentWidth: el.scrollWidth,
        panelWidth: el.clientWidth,
      };
    });
    expect(geometry.addTop).toBeGreaterThanOrEqual(geometry.viewportTop);
    expect(geometry.addBottom).toBeLessThanOrEqual(geometry.viewportBottom);
    expect(geometry.contentWidth).toBeLessThanOrEqual(geometry.panelWidth + 1);
    console.log("Quick entry geometry", JSON.stringify(geometry));
    checks.push(
      "Quick entry autofocuses the title, defaults to today and keeps Add visible above the keyboard without scrolling",
    );
  }
  await mobile
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill(mobileTitle);
  await mobile
    .getByRole("dialog")
    .getByRole("button", { name: /^(添加|保存)$/, exact: true })
    .click();
  await expect(mobile.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(() => findTask(mobileTitle), { timeout: 90000 })
    .toBeTruthy();
  checks.push(
    "Android UI task automatically arrived in the Windows native database through the ECS",
  );

  if (quickTaskSmoke) {
    const today = (await findTask(mobileTitle)).data.executionDate;
    const shift = (date, n) => {
      const d = new Date(date + "T12:00:00Z");
      d.setUTCDate(d.getUTCDate() + n);
      return d.toISOString().slice(0, 10);
    };
    for (const [choice, planned] of [
      ["明天", shift(today, 1)],
      ["没有日期", null],
      ["选择日期", shift(today, 4)],
    ]) {
      await mobile
        .getByRole("button", { name: "新建任务", exact: true })
        .click();
      const panel = mobile.getByRole("dialog", {
        name: "快速添加任务",
        exact: true,
      });
      const title = stamp + " 快速添加 " + choice;
      await panel.getByLabel("名称", { exact: true }).fill(title);
      if (choice === "选择日期")
        await panel.getByLabel("选择安排日期", { exact: true }).fill(planned);
      else
        await panel.getByRole("button", { name: choice, exact: true }).click();
      await panel.getByRole("button", { name: "添加", exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect
        .poll(
          async () => {
            const t = await findTask(title);
            return t ? (t.data.executionDate ?? null) : "missing";
          },
          { timeout: 90000 },
        )
        .toBe(planned);
    }
    checks.push(
      "Tomorrow, no date and custom date create tasks with the exact dates in Windows storage through cloud sync",
    );
    await mobile.getByRole("button", { name: "新建任务", exact: true }).click();
    const panel = mobile.getByRole("dialog", {
      name: "快速添加任务",
      exact: true,
    });
    const enterTitle = stamp + " 键盘回车";
    await panel.getByLabel("名称", { exact: true }).fill(enterTitle);
    await panel.getByLabel("名称", { exact: true }).press("Enter");
    await expect(panel).toHaveCount(0);
    await expect
      .poll(
        async () =>
          (await desktopEntities()).filter(
            (e) =>
              e.kind === "task" && !e.deleted && e.data.title === enterTitle,
          ).length,
        { timeout: 90000 },
      )
      .toBe(1);
    checks.push(
      "Keyboard Enter saves exactly one task without opening task details",
    );
    await mobile.getByRole("button", { name: "新建任务", exact: true }).click();
    await panel.getByLabel("名称", { exact: true }).fill(stamp + " 更多选项");
    await panel
      .getByLabel("任务描述", { exact: true })
      .fill("快速添加中填写的描述");
    await panel.getByRole("button", { name: "明天", exact: true }).click();
    await panel.getByRole("button", { name: "更多选项", exact: false }).click();
    const full = mobile.getByRole("dialog");
    await expect(full.getByLabel("名称", { exact: true })).toHaveValue(
      stamp + " 更多选项",
    );
    await expect(full.getByLabel("备注", { exact: false })).toHaveValue(
      "快速添加中填写的描述",
    );
    await expect(full.getByLabel("安排日期", { exact: true })).toHaveValue(
      shift(today, 1),
    );
    await full.getByRole("button", { name: "保存", exact: true }).click();
    await expect(full).toHaveCount(0);
    await expect
      .poll(() => findTask(stamp + " 更多选项"), { timeout: 90000 })
      .toBeTruthy();
    checks.push(
      "More options preserves the title, description and date and saves through the existing full editor",
    );
    console.log(
      "Quick task date shortcuts, keyboard submit and full-editor handoff passed",
    );
  }

  await mobile
    .getByRole("button", { name: "完成：" + desktopTitle, exact: true })
    .click();
  await expect
    .poll(async () => (await findTask(desktopTitle))?.data.status, {
      timeout: 90000,
    })
    .toBe("completed");
  checks.push(
    "Android completion of the Windows-created task synchronized back to Windows",
  );
  console.log("Bidirectional creation and completion synchronization passed");
  await mobile.screenshot({
    path: join(evidence, "android-tasks.png"),
    fullPage: true,
  });
  await desktop.screenshot({
    path: join(evidence, "desktop-tasks.png"),
    fullPage: true,
  });

  await restartMobile();
  expect((await native("accountStatus")).user.email).toBe(email);
  await mobileNav("清单");
  await expect(
    mobile.locator(".pm-task-title strong", { hasText: mobileTitle }),
  ).toHaveCount(1);
  await ipc("account_restart").catch(() => {});
  await connectDesktop();
  expect((await ipc("account_status")).user.email).toBe(email);
  expect(await findTask(mobileTitle)).toBeTruthy();
  expect((await findTask(desktopTitle)).data.status).toBe("completed");
  await expect
    .poll(async () => (await ipc("lan_sync_status")).state, { timeout: 60000 })
    .toBe("online");
  checks.push(
    "Both apps retained their login and synchronized tasks after native process restart",
  );
  await desktopSettings();
  await desktop.screenshot({
    path: join(evidence, "desktop-account.png"),
    fullPage: true,
  });
  await mobileNav("我的");
  await mobile.screenshot({
    path: join(evidence, "android-account.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
} catch (error) {
  errors.push(String(error));
  if (desktop)
    errors.push(
      ...(await desktop
        .getByRole("alert")
        .allTextContents()
        .catch(() => [])),
    );
  await desktop
    ?.screenshot({ path: join(evidence, "desktop-failure.png") })
    .catch(() => {});
  await mobile
    ?.screenshot({ path: join(evidence, "android-failure.png") })
    .catch(() => {});
  process.exitCode = 1;
} finally {
  if (handwriting !== undefined) {
    if (handwriting === "null")
      adb(
        "shell",
        "settings",
        "delete",
        "secure",
        "stylus_handwriting_enabled",
      );
    else
      adb(
        "shell",
        "settings",
        "put",
        "secure",
        "stylus_handwriting_enabled",
        handwriting,
      );
  }
  if (hardwareKeyboard !== undefined) {
    if (hardwareKeyboard === "null")
      adb(
        "shell",
        "settings",
        "delete",
        "secure",
        "show_ime_with_hard_keyboard",
      );
    else
      adb(
        "shell",
        "settings",
        "put",
        "secure",
        "show_ime_with_hard_keyboard",
        hardwareKeyboard,
      );
  }
  if (mobileTestAccount && mobile) {
    const current = await native("accountStatus").catch(() => null);
    if (current?.user?.email === email) {
      await native("accountLogout");
      await restartMobile();
      await mobileNav("清单");
      const after = await mobile
        .locator(".pm-task-title strong")
        .allTextContents();
      if (JSON.stringify(after) !== JSON.stringify(mobileGuestTitles)) {
        errors.push("Android original workspace changed");
        process.exitCode = 1;
      } else
        checks.push(
          "Android logged out of the verification account and original local task list was preserved",
        );
    }
  }
  const status = await ipc("account_status").catch(() => null);
  if (status?.user?.email === email) await desktopLogout().catch(() => {});
  await db?.close().catch(() => {});
  await mb?.close().catch(() => {});
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
  adb("forward", "--remove", `tcp:${mobilePort}`);
  const result = {
    status: errors.length ? "failed" : "passed",
    testedAt: new Date().toISOString(),
    baseUrl,
    android: "Android 17 emulator-5554 (not a physical phone)",
    checks,
    errors,
  };
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  console.log(JSON.stringify(result, null, 2));
}
