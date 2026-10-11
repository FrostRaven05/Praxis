import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { restartAndroidForSyncTest } from "./android-sync-test.mjs";
await restartAndroidForSyncTest();
const db = await chromium.connectOverCDP("http://127.0.0.1:9222"),
  mb = await chromium.connectOverCDP("http://127.0.0.1:9223");
const desktop = db.contexts()[0].pages()[0],
  mobile = mb.contexts()[0].pages()[0];
const prior = JSON.parse(
    await readFile("docs/evidence/lan-full-sync/result.json", "utf8"),
  ),
  stamp = prior.stamp,
  tag = stamp + " 内容 " + Date.now(),
  checks = [],
  errors = [];
const ipc = (cmd, args = {}) =>
  desktop.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
const entities = () => ipc("lan_entity_snapshot");
const project = (await entities()).find(
    (e) => e.kind === "project" && e.data.title === stamp,
  ),
  task = (await entities()).find(
    (e) => e.kind === "task" && e.data.projectId === project.id,
  );
const nav = async (name) => {
  await mobile.getByRole("button", { name: "打开菜单", exact: true }).click();
  await mobile
    .getByRole("navigation", { name: "功能菜单" })
    .getByRole("button", { name, exact: true })
    .click();
};
const command = (name, action) =>
  ipc(name, {
    command: {
      operationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      action,
    },
  });
const find = async (kind, title) =>
  (await entities()).find(
    (e) => e.kind === kind && e.data.title === title && !e.deleted,
  );
try {
  await mobile.getByRole("button", { name: "打开菜单", exact: true }).waitFor();
  await nav("我的");
  await mobile
    .locator(".pm-settings-group > summary")
    .filter({ hasText: "时间与日期" })
    .click();
  await mobile
    .getByLabel("工作空间时区", { exact: true })
    .fill("Asia/Hong_Kong");
  await mobile.getByRole("button", { name: "保存时区", exact: true }).click();
  await expect
    .poll(
      async () => (await ipc("productivity_snapshot")).settings[0]?.timeZone,
      { timeout: 60000 },
    )
    .toBe("Asia/Hong_Kong");
  await nav("记录");
  await mobile.getByLabel("标题", { exact: true }).fill(tag + " 关联记录");
  await mobile.getByLabel(/^正文/).fill("手机关联原文");
  await mobile.getByLabel(/^关联项目/).selectOption(project.id);
  await mobile.getByLabel(/^关联任务/).selectOption(task.id);
  await mobile.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect
    .poll(() => find("record", tag + " 关联记录"), { timeout: 60000 })
    .toBeTruthy();
  let content = await ipc("content_snapshot");
  let record = content.records.find((r) => r.title === tag + " 关联记录");
  expect(record.links).toEqual(
    expect.arrayContaining([
      { targetType: "project", targetId: project.id },
      { targetType: "task", targetId: task.id },
    ]),
  );
  await command("content_command", {
    type: "record",
    id: record.id,
    expectedVersion: record.version,
    title: record.title,
    body: "桌面更新的关联正文",
    recordType: record.recordType,
    links: record.links,
  });
  await expect(
    mobile.locator("article").filter({ hasText: tag + " 关联记录" }),
  ).toContainText("桌面更新的关联正文", { timeout: 60000 });
  checks.push(
    "Mobile record links to project and task arrive in native content; desktop body edit returns to mobile with links intact",
  );
  await nav("习惯");
  await mobile.getByLabel("习惯名称", { exact: true }).fill(tag + " 习惯");
  await mobile.getByRole("button", { name: "创建", exact: true }).click();
  await expect
    .poll(() => find("habit", tag + " 习惯"), { timeout: 60000 })
    .toBeTruthy();
  const habit = await find("habit", tag + " 习惯"),
    date = new Date().toLocaleDateString("en-CA", {
      timeZone: "Asia/Hong_Kong",
    });
  let card = mobile.locator("article").filter({
    has: mobile.getByRole("heading", { name: tag + " 习惯", exact: true }),
  });
  await card.getByRole("button", { name: "完成", exact: true }).click();
  const readHabit = async () =>
    (await ipc("habit_snapshot", { date })).habits.find(
      (row) => row.habit.id === habit.id,
    );
  await expect
    .poll(async () => (await readHabit())?.entry?.status, { timeout: 60000 })
    .toBe("done");
  let h = await readHabit();
  await command("habit_command", {
    type: "entry",
    id: habit.id,
    date,
    status: "done",
    note: "桌面同日备注",
    timeZone: (await ipc("habit_snapshot", { date })).timeZone,
    expectedVersion: h.entry.version,
  });
  await expect(card).toContainText("桌面同日备注", { timeout: 60000 });
  await expect
    .poll(
      async () =>
        (await entities()).filter(
          (e) =>
            e.kind === "habit_check" &&
            e.data.habitId === habit.id &&
            e.data.date === date &&
            !e.deleted,
        ).length,
      { timeout: 60000 },
    )
    .toBe(1);
  await card.getByRole("button", { name: "撤销", exact: true }).click();
  await expect
    .poll(async () => (await readHabit())?.entry?.status ?? null, {
      timeout: 60000,
    })
    .toBeNull();
  await card.getByRole("button", { name: "完成", exact: true }).click();
  await expect
    .poll(async () => (await readHabit())?.entry?.status, { timeout: 60000 })
    .toBe("done");
  checks.push(
    "Habit rule and same-day check synchronize; desktop same-day update does not duplicate; mobile undo and re-complete retain identity",
  );
  await nav("重复任务");
  await mobile.getByLabel("重复任务标题", { exact: true }).fill(tag + " 重复");
  await mobile.getByRole("button", { name: "创建", exact: true }).click();
  await expect
    .poll(() => find("recurrence", tag + " 重复"), { timeout: 60000 })
    .toBeTruthy();
  const repeat = await find("recurrence", tag + " 重复");
  let repeatCard = mobile.locator("article").filter({
    has: mobile.getByRole("heading", { name: tag + " 重复", exact: true }),
  });
  await repeatCard
    .getByRole("button", { name: "补齐至未来 30 天", exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await entities()).filter(
          (e) => e.kind === "task" && e.data.recurrenceId === repeat.id,
        ).length,
      { timeout: 90000 },
    )
    .toBeGreaterThanOrEqual(30);
  const before = (await entities()).filter(
    (e) => e.kind === "task" && e.data.recurrenceId === repeat.id,
  );
  await command("recurrence_command", {
    type: "expand",
    id: repeat.id,
    through: before
      .map((e) => e.data.originalDate)
      .sort()
      .at(-1),
    batchSize: 100,
  });
  const after = (await entities()).filter(
    (e) => e.kind === "task" && e.data.recurrenceId === repeat.id,
  );
  expect(after.length).toBe(before.length);
  expect(new Set(after.map((e) => e.data.originalDate)).size).toBe(
    after.length,
  );
  checks.push(
    "Mobile recurrence expansion arrives on desktop; native expansion of same date range keeps one logical task per day",
  );
  await nav("策略与决策");
  await mobile.getByRole("button", { name: "新建策略", exact: true }).click();
  await mobile.getByLabel("标题", { exact: true }).fill(tag + " 策略");
  await mobile.getByLabel(/^正文/).fill("问题：跨端资料\n方针：保留来源");
  await mobile.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect
    .poll(() => find("strategy", tag + " 策略"), { timeout: 60000 })
    .toBeTruthy();
  let strategy = await find("strategy", tag + " 策略");
  await ipc("lan_entity_edit", {
    operationId: crypto.randomUUID(),
    expected: strategy,
    entity: {
      ...strategy,
      data: { ...strategy.data, body: "桌面补充策略依据" },
    },
  });
  await expect(
    mobile.locator("article").filter({ hasText: tag + " 策略" }),
  ).toContainText("桌面补充策略依据", { timeout: 60000 });
  checks.push("Non-AI strategy notes synchronize in both directions");
  await desktop.screenshot({
    path: "docs/evidence/lan-full-sync/desktop-final.png",
    fullPage: true,
  });
  await mobile.screenshot({
    path: "docs/evidence/lan-full-sync/android-final.png",
    fullPage: true,
  });
} catch (e) {
  errors.push(String(e));
  throw e;
} finally {
  await writeFile(
    "docs/evidence/lan-full-sync/domains.json",
    JSON.stringify(
      { testedAt: new Date().toISOString(), tag, checks, errors },
      null,
      2,
    ),
  );
  await db.close();
  await mb.close();
  console.log(JSON.stringify({ checks, errors }, null, 2));
}
process.exit(0);
