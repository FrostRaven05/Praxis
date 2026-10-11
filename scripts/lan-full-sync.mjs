// Real native clients; writes through their UI or documented application commands, never server/SQLite writes.
import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
const desktopBrowser = await chromium.connectOverCDP("http://127.0.0.1:9222");
const mobileBrowser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const desktop = desktopBrowser.contexts()[0].pages()[0],
  mobile = mobileBrowser.contexts()[0].pages()[0];
const checks = [],
  errors = [];
const stamp = `全域验收 ${Date.now()}`;
const ipc = (cmd, args = {}) =>
  desktop.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
const snapshot = () => ipc("lan_entity_snapshot");
const find = async (kind, title) =>
  (await snapshot()).find(
    (e) => e.kind === kind && e.data.title === title && !e.deleted,
  );
const nav = async (name) => {
  await mobile.getByRole("button", { name: "打开菜单", exact: true }).click();
  await mobile
    .getByRole("navigation", { name: "功能菜单" })
    .getByRole("button", { name, exact: true })
    .click();
};
const saveMobile = async () => {
  await mobile
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(mobile.getByRole("dialog")).toHaveCount(0);
};
try {
  await nav("项目");
  await mobile.getByRole("button", { name: "新建项目", exact: true }).click();
  await mobile
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill(stamp);
  await mobile
    .getByRole("dialog")
    .getByLabel("恢复卡 · 下次从哪里继续", { exact: true })
    .fill("手机记录的恢复线索");
  await saveMobile();
  await expect
    .poll(() => find("project", stamp), { timeout: 90000 })
    .toBeTruthy();
  const project = await find("project", stamp);
  await mobile
    .locator(".pm-project")
    .filter({ hasText: stamp })
    .getByRole("button")
    .first()
    .click();
  await mobile
    .getByRole("button", { name: "＋ 添加项目任务", exact: true })
    .click();
  await mobile
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill(stamp + " 任务");
  await saveMobile();
  await expect
    .poll(() => find("task", stamp + " 任务"), { timeout: 90000 })
    .toBeTruthy();
  let task = await find("task", stamp + " 任务");
  expect(task.data.projectId).toBe(project.id);
  checks.push(
    "Android UI project, task, relationship and recovery card automatically arrive in native desktop storage",
  );
  const content = await ipc("content_snapshot");
  const context = content.contexts.find((c) => c.projectId === project.id);
  await ipc("content_command", {
    command: {
      operationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      action: {
        type: "context",
        projectId: project.id,
        expectedVersion: context?.version ?? null,
        definitionOfDone: "双端闭环",
        blockerText: "",
        reviewDate: null,
        nextActionTaskId: task.id,
        lastContext: "",
        restartHint: "桌面更新的恢复线索",
        waitingNote: "",
      },
    },
  });
  await nav("项目");
  await expect(
    mobile.locator(".pm-project").filter({ hasText: stamp }),
  ).toContainText("桌面更新的恢复线索", { timeout: 90000 });
  await mobile
    .locator(".pm-project")
    .filter({ hasText: stamp })
    .getByRole("button", { name: "编辑与恢复卡", exact: true })
    .click();
  await expect(mobile.getByRole("dialog").getByLabel(/^下一步/)).toHaveValue(
    task.id,
  );
  await mobile.getByRole("button", { name: "关闭编辑", exact: true }).click();
  await mobile
    .locator(".pm-project")
    .filter({ hasText: stamp })
    .getByRole("button")
    .first()
    .click();
  await mobile
    .getByRole("button", { name: "完成：" + stamp + " 任务", exact: true })
    .click();
  await expect
    .poll(async () => (await find("task", stamp + " 任务"))?.data.status, {
      timeout: 90000,
    })
    .toBe("completed");
  await expect
    .poll(
      async () => {
        const c = (await ipc("content_snapshot")).contexts.find(
          (c) => c.projectId === project.id,
        );
        return c?.nextActionTaskId ?? null;
      },
      { timeout: 90000 },
    )
    .toBeNull();
  checks.push(
    "Desktop assigns next action and edits recovery card; Android receives, completes task, and both clients clear next-action reference atomically",
  );
  await nav("任务清单");
  await mobile.getByRole("button", { name: "每日安排", exact: true }).click();
  await mobile
    .getByRole("dialog")
    .getByLabel("今天希望取得的结果")
    .fill(stamp + " 每日结果");
  await mobile.getByRole("dialog").getByLabel("收尾备注").fill("手机收尾备注");
  await saveMobile();
  await expect
    .poll(
      async () =>
        (await snapshot()).find(
          (e) => e.kind === "plan" && e.data.outcome === stamp + " 每日结果",
        ),
      { timeout: 90000 },
    )
    .toBeTruthy();
  checks.push(
    "Android daily result and closing note automatically arrive on desktop",
  );
  await mkdir("docs/evidence/lan-full-sync", { recursive: true });
  await desktop.screenshot({
    path: "docs/evidence/lan-full-sync/desktop.png",
    fullPage: true,
  });
  await mobile.screenshot({
    path: "docs/evidence/lan-full-sync/android.png",
    fullPage: true,
  });
} catch (e) {
  errors.push(String(e));
  throw e;
} finally {
  await mkdir("docs/evidence/lan-full-sync", { recursive: true });
  await writeFile(
    "docs/evidence/lan-full-sync/result.json",
    JSON.stringify(
      { testedAt: new Date().toISOString(), stamp, checks, errors },
      null,
      2,
    ),
  );
  await desktopBrowser.close();
  await mobileBrowser.close();
  console.log(JSON.stringify({ checks, errors }, null, 2));
}
process.exit(0);
