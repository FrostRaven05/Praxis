// Fault scenarios operate only on captures/projects created by lan-full-sync.mjs.
import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, join } from "node:path";
import { restartAndroidForSyncTest } from "./android-sync-test.mjs";
await restartAndroidForSyncTest();
const root = resolve(import.meta.dirname, ".."),
  adbPath = join(
    process.env.LOCALAPPDATA,
    "Android/Sdk/platform-tools/adb.exe",
  );
const adb = (...args) =>
  execFileSync(adbPath, ["-s", "emulator-5554", ...args], {
    encoding: "utf8",
    windowsHide: true,
  }).trim();
const ps = (file, args = []) =>
  execFileSync("pwsh", ["-NoProfile", "-File", resolve(root, file), ...args], {
    cwd: root,
    windowsHide: true,
    stdio: "ignore",
  });
const prior = JSON.parse(
  await readFile(
    resolve(root, "docs/evidence/lan-full-sync/result.json"),
    "utf8",
  ),
);
const stamp = prior.stamp,
  checks = [],
  errors = [];
const runStamp = `${stamp} 故障 ${Date.now()}`;
const db = await chromium.connectOverCDP("http://127.0.0.1:9222");
const desktop = db.contexts()[0].pages()[0];
let mb = await chromium.connectOverCDP("http://127.0.0.1:9223"),
  mobile = mb.contexts()[0].pages()[0];
let offline = false,
  stopped = false;
const ipc = (cmd, args = {}) =>
  desktop.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
const snapshot = () => ipc("lan_entity_snapshot");
const project = (await snapshot()).find(
  (e) => e.kind === "project" && e.data.title === stamp,
);
let task = (await snapshot()).find(
  (e) => e.kind === "task" && e.data.projectId === project.id,
);
const id = task.id;
const current = async () => (await snapshot()).find((e) => e.id === id);
async function desktopEdit(field, value) {
  const expected = await current();
  await ipc("lan_entity_edit", {
    operationId: crypto.randomUUID(),
    expected,
    entity: { ...expected, data: { ...expected.data, [field]: value } },
  });
}
async function nav(name) {
  await mobile.getByRole("button", { name: "打开菜单", exact: true }).click();
  await mobile
    .getByRole("navigation", { name: "功能菜单" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function taskList() {
  await nav("项目");
  await mobile
    .locator(".pm-project")
    .filter({ hasText: stamp })
    .getByRole("button")
    .first()
    .click();
}
async function editMobile(title, note) {
  await mobile
    .getByRole("button", { name: title, exact: false })
    .filter({ has: mobile.locator("strong") })
    .click();
  await mobile.getByRole("dialog").getByLabel(/^备注/).fill(note);
  await mobile
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(mobile.getByRole("dialog")).toHaveCount(0);
}
async function reconnect() {
  for (let i = 0; i < 40; i++) {
    try {
      const pid = adb("shell", "pidof", "com.praxis.mobile");
      adb(
        "forward",
        "tcp:9223",
        `localabstract:webview_devtools_remote_${pid}`,
      );
      mb = await chromium.connectOverCDP("http://127.0.0.1:9223");
      mobile = mb.contexts()[0].pages()[0];
      await mobile
        .getByRole("button", { name: "打开菜单", exact: true })
        .waitFor({ timeout: 1500 });
      return;
    } catch {
      await mb?.close().catch(() => {});
      await delay(500);
    }
  }
  throw Error("Android restart did not reconnect");
}
try {
  await mobile.getByRole("button", { name: "打开菜单", exact: true }).waitFor();
  await taskList();
  adb("shell", "svc", "wifi", "disable");
  adb("shell", "svc", "data", "disable");
  offline = true;
  const note = runStamp + " 离线备注";
  await editMobile(task.data.title, note);
  await desktopEdit("title", runStamp + " 桌面独立标题");
  await expect
    .poll(async () => (await ipc("lan_sync_status")).entityPending, {
      timeout: 60000,
    })
    .toBe(0);
  await mb.close();
  adb("shell", "am", "force-stop", "com.praxis.mobile");
  adb("shell", "am", "start", "-n", "com.praxis.mobile/.MainActivity");
  await reconnect();
  await taskList();
  await mobile
    .getByRole("button", { name: task.data.title, exact: false })
    .filter({ has: mobile.locator("strong") })
    .click();
  await expect(mobile.getByRole("dialog").getByLabel(/^备注/)).toHaveValue(
    note,
  );
  await mobile.getByRole("button", { name: "关闭编辑", exact: true }).click();
  adb("shell", "svc", "wifi", "enable");
  adb("shell", "svc", "data", "enable");
  offline = false;
  await expect
    .poll(async () => (await current()).data.notes, { timeout: 90000 })
    .toBe(note);
  await expect(
    mobile.getByText(runStamp + " 桌面独立标题", { exact: true }),
  ).toBeVisible({ timeout: 60000 });
  checks.push(
    "Offline Android edit survives force-stop/restart; reconnect merges its note with desktop independent title without losing either field",
  );
  task = await current();
  adb("shell", "svc", "wifi", "disable");
  adb("shell", "svc", "data", "disable");
  offline = true;
  const local = runStamp + " 手机冲突备注",
    remote = runStamp + " 桌面冲突备注";
  await editMobile(task.data.title, local);
  await desktopEdit("notes", remote);
  await expect
    .poll(async () => (await ipc("lan_sync_status")).entityPending, {
      timeout: 60000,
    })
    .toBe(0);
  await delay(6500);
  adb("shell", "svc", "wifi", "enable");
  adb("shell", "svc", "data", "enable");
  offline = false;
  await mobile.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "我的", exact: true }).click();
  const panel = mobile.locator(".pm-lan-sync");
  if ((await panel.getByText(/最近成功：/).count()) === 0)
    await mobile.getByTestId("lan-sync-status").click();
  const conflict = panel
    .getByTestId("entity-sync-conflict")
    .filter({ hasText: local });
  await expect(conflict).toHaveCount(1, { timeout: 60000 });
  await expect(conflict).toContainText(remote);
  // An unrelated project must remain syncable while the task conflict is open.
  const now = new Date().toISOString(),
    other = {
      id: crypto.randomUUID(),
      kind: "project",
      version: 1,
      data: { title: runStamp + " 无关项目", status: "active" },
      deleted: false,
      createdAt: now,
      updatedAt: now,
    };
  await ipc("lan_entity_edit", {
    operationId: crypto.randomUUID(),
    entity: other,
    expected: null,
  });
  await nav("项目");
  await expect(
    mobile.locator(".pm-project").filter({ hasText: other.data.title }),
  ).toHaveCount(1, { timeout: 90000 });
  mobile.once("dialog", (d) => d.accept());
  await conflict
    .getByRole("button", { name: "保留本机版本", exact: true })
    .click();
  await expect
    .poll(async () => (await current()).data.notes, { timeout: 90000 })
    .toBe(local);
  checks.push(
    "Same-field edits retain both texts in a real Android conflict; unrelated project continues syncing; explicit local resolution converges",
  );
  ps("scripts/stop-lan.ps1");
  stopped = true;
  const queued = runStamp + " 服务停机备注";
  await desktopEdit("notes", queued);
  await expect
    .poll(async () => (await ipc("lan_sync_status")).state, { timeout: 30000 })
    .toBe("offline");
  ps("scripts/start-lan.ps1", ["-LanAddress", "192.168.5.56"]);
  stopped = false;
  await expect
    .poll(async () => (await ipc("lan_sync_status")).state, { timeout: 60000 })
    .toBe("online");
  await expect
    .poll(
      async () => {
        await taskList();
        await mobile
          .getByRole("button", { name: task.data.title, exact: false })
          .filter({ has: mobile.locator("strong") })
          .click();
        const value = await mobile
          .getByRole("dialog")
          .getByLabel(/^备注/)
          .inputValue();
        await mobile
          .getByRole("button", { name: "关闭编辑", exact: true })
          .click();
        return value;
      },
      { timeout: 90000 },
    )
    .toBe(queued);
  checks.push(
    "Backend stop preserves desktop edits; new server generation reconciles snapshot and automatically delivers pending note to Android",
  );
} catch (e) {
  errors.push(String(e));
  throw e;
} finally {
  if (offline) {
    adb("shell", "svc", "wifi", "enable");
    adb("shell", "svc", "data", "enable");
  }
  if (stopped) ps("scripts/start-lan.ps1", ["-LanAddress", "192.168.5.56"]);
  await writeFile(
    resolve(root, "docs/evidence/lan-full-sync/faults.json"),
    JSON.stringify(
      { testedAt: new Date().toISOString(), stamp, checks, errors },
      null,
      2,
    ),
  );
  await db.close();
  await mb.close();
  console.log(JSON.stringify({ checks, errors }, null, 2));
}
process.exit(0);
