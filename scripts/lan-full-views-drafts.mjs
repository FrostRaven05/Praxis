import { chromium, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { restartAndroidForSyncTest } from "./android-sync-test.mjs";
await restartAndroidForSyncTest();
const db = await chromium.connectOverCDP("http://127.0.0.1:9222"),
  mb = await chromium.connectOverCDP("http://127.0.0.1:9223"),
  desktop = db.contexts()[0].pages()[0],
  mobile = mb.contexts()[0].pages()[0];
const prior = JSON.parse(
    await readFile("docs/evidence/lan-full-sync/result.json", "utf8"),
  ),
  stamp = prior.stamp,
  tag = stamp + " 视图 " + Date.now(),
  checks = [],
  errors = [];
const ipc = (cmd, args = {}) =>
  desktop.evaluate(
    ({ cmd, args }) => window.__TAURI_INTERNALS__.invoke(cmd, args),
    { cmd, args },
  );
const command = (name, action) =>
  ipc(name, {
    command: {
      operationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      action,
    },
  });
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
try {
  await desktop.reload();
  await desktop
    .getByRole("button", { name: "今日与近期", exact: true })
    .waitFor();
  await mobile.getByRole("button", { name: "打开菜单", exact: true }).waitFor();
  const id = crypto.randomUUID(),
    query = {
      text: stamp,
      entityType: "task",
      projectId: project.id,
      status: null,
      includeArchived: false,
      groups: [[{ field: "priority", op: "eq", value: "4" }]],
      sort: "title",
      groupBy: "project",
    };
  await command("view_command", {
    type: "save",
    id,
    expectedVersion: null,
    name: tag + " 桌面筛选",
    query,
    followed: true,
  });
  await nav("搜索与视图");
  await expect(
    mobile.getByRole("button", { name: tag + " 桌面筛选", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await mobile
    .getByRole("button", { name: tag + " 桌面筛选", exact: true })
    .click();
  await expect(
    mobile.locator("article").filter({ hasText: task.data.title }),
  ).toHaveCount(1);
  checks.push(
    "Desktop saved view with project and priority conditions synchronizes and executes in Android",
  );
  await nav("搜索与视图");
  if (
    await mobile
      .getByRole("button", { name: "返回手机自定义筛选", exact: true })
      .count()
  )
    await mobile
      .getByRole("button", { name: "返回手机自定义筛选", exact: true })
      .click();
  await mobile.getByLabel(/^搜索标题或正文/).fill(stamp);
  await mobile.getByLabel("视图名称", { exact: true }).fill(tag + " 手机筛选");
  await mobile.getByRole("button", { name: "保存视图", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await ipc("view_snapshot")).views.find(
          (v) => v.name === tag + " 手机筛选",
        ),
      { timeout: 60000 },
    )
    .toBeTruthy();
  const imported = (await ipc("view_snapshot")).views.find(
    (v) => v.name === tag + " 手机筛选",
  );
  const result = await ipc("view_query", { query: imported.query });
  expect(result.rows.some((r) => r.id === task.id)).toBe(true);
  checks.push(
    "Android flat saved view arrives as executable native filter, preserving its original semantics",
  );
  const instantTaskId = crypto.randomUUID();
  const instantTitle = tag + " 跨午夜任务";
  await command("productivity_command", {
    type: "task",
    id: instantTaskId,
    expectedVersion: null,
    title: instantTitle,
    notes: "",
    projectId: null,
    plan: null,
    deadline: {
      kind: "instant",
      atUtc: "2026-10-10T23:30:00Z",
      displayTimezone: "UTC",
    },
    followUp: null,
    priority: 4,
    waitingFor: "",
    waitingNote: "",
    labels: [],
  });
  const instantQuery = {
    ...query,
    text: instantTitle,
    projectId: null,
    groups: [[{ field: "deadline", op: "eq", value: "2026-10-11" }]],
  };
  expect(
    (await ipc("view_query", { query: instantQuery })).rows.some(
      (r) => r.id === instantTaskId,
    ),
  ).toBe(true);
  await command("view_command", {
    type: "save",
    id: crypto.randomUUID(),
    expectedVersion: null,
    name: tag + " 跨午夜筛选",
    query: instantQuery,
    followed: false,
  });
  await expect(
    mobile.getByRole("button", { name: tag + " 跨午夜筛选", exact: true }),
  ).toBeVisible({ timeout: 60000 });
  await mobile
    .getByRole("button", { name: tag + " 跨午夜筛选", exact: true })
    .click();
  await expect(
    mobile.locator("article").filter({ hasText: instantTitle }),
  ).toHaveCount(1);
  checks.push(
    "Both native clients execute the same saved-view deadline predicate for an instant crossing midnight between display and workspace timezones",
  );
  await nav("回顾");
  await mobile.getByRole("button", { name: "新建回顾", exact: true }).click();
  await mobile.getByLabel("标题", { exact: true }).fill(tag + " 周回顾");
  await mobile.getByLabel(/^推进成果/).fill("手机成果");
  await mobile.getByLabel(/^阻塞/).fill("尚无阻塞");
  await mobile.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await ipc("review_snapshot")).reviews.find(
          (r) => r.achievements === "手机成果" && r.blockers === "尚无阻塞",
        ),
      { timeout: 60000 },
    )
    .toBeTruthy();
  let review = (await ipc("review_snapshot")).reviews.find(
    (r) => r.achievements === "手机成果" && r.blockers === "尚无阻塞",
  );
  await command("review_command", {
    type: "save",
    id: review.id,
    expectedVersion: review.version,
    start: review.start,
    end: review.end,
    achievements: review.achievements,
    blockers: "桌面更新阻塞",
    stopPause: review.stopPause,
    nextFocus: review.nextFocus,
    projectIds: review.projectIds,
  });
  await expect(
    mobile.locator("article").filter({ hasText: tag + " 周回顾" }),
  ).toContainText("桌面更新阻塞", { timeout: 60000 });
  checks.push(
    "Android structured weekly review reaches native dedicated review; desktop field edit returns to mobile with consistent body",
  );
  await desktop
    .getByRole("button", { name: "今日与近期", exact: true })
    .click();
  await desktop.getByRole("button", { name: "今日", exact: true }).click();
  await expect(
    desktop.getByLabel("主要推进结果", { exact: true }),
  ).toBeVisible();
  const local = tag + " 未保存草稿",
    remote = tag + " 手机每日结果";
  const daySnapshot = await ipc("productivity_snapshot");
  const selectedDate =
    (await desktop.getByLabel("所选日期", { exact: true }).inputValue()) ||
    new Intl.DateTimeFormat("en-CA", {
      timeZone: daySnapshot.settings[0]?.timeZone ?? "UTC",
    }).format(new Date());
  const dayBase = daySnapshot.days.find((d) => d.date === selectedDate);
  await desktop.getByLabel("主要推进结果", { exact: true }).fill(local);
  await nav("任务清单");
  await mobile.getByRole("button", { name: "每日安排", exact: true }).click();
  await mobile
    .getByRole("dialog")
    .getByLabel(/^今天希望取得的结果/)
    .fill(remote);
  await mobile
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(mobile.getByRole("dialog")).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await ipc("productivity_snapshot")).days.some(
          (d) => d.outcome === remote,
        ),
      { timeout: 60000 },
    )
    .toBe(true);
  let staleNativeSaveRejected = false;
  let staleNativeError = "";
  const remoteDay = (await ipc("productivity_snapshot")).days.find(
    (d) => d.date === selectedDate,
  );
  expect(remoteDay.version).toBeGreaterThan(dayBase?.version ?? -1);
  try {
    await command("productivity_command", {
      type: "day",
      date: selectedDate,
      outcome: local,
      closing: dayBase?.closing ?? "",
      focusIds: dayBase?.focusIds ?? [],
      expectedVersion: dayBase?.version ?? null,
    });
  } catch (e) {
    staleNativeError = String(e);
    staleNativeSaveRejected =
      /STATE_CONFLICT|内容已更新，请返回并重新打开后再预览/.test(String(e));
  }
  if (!staleNativeSaveRejected)
    throw Error(
      staleNativeError || "Stale native save was unexpectedly accepted",
    );
  await expect(desktop.getByLabel("主要推进结果", { exact: true })).toHaveValue(
    local,
  );
  await desktop
    .getByRole("button", { name: "保存每日结果", exact: true })
    .click();
  await expect(desktop.getByRole("alert")).toContainText(
    /STATE_CONFLICT|版本|改变|内容已更新/,
  );
  await expect(desktop.getByLabel("主要推进结果", { exact: true })).toHaveValue(
    local,
  );
  expect(
    (await ipc("productivity_snapshot")).days.some((d) => d.outcome === remote),
  ).toBe(true);
  expect(
    (await ipc("productivity_snapshot")).days.some((d) => d.outcome === local),
  ).toBe(false);
  await desktop
    .getByRole("button", { name: "放弃每日修改", exact: true })
    .click();
  await expect(desktop.getByLabel("主要推进结果", { exact: true })).toHaveValue(
    remote,
    { timeout: 30000 },
  );
  checks.push(
    "Remote daily-plan update preserves unsaved desktop draft; native Store CAS and stale UI save both reject old versions; explicit discard loads latest remote result",
  );
} catch (e) {
  errors.push(String(e));
  throw e;
} finally {
  await writeFile(
    "docs/evidence/lan-full-sync/views-drafts.json",
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
