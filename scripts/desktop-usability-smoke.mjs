import { chromium, expect } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, copyFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const root = resolve("."),
  release = resolve(".tools/releases/desktop-usability/Praxis.exe");
const evidence = resolve("docs/evidence/desktop-usability");
const dir = await mkdtemp(resolve(".tools/usability-test-"));
await mkdir(evidence, { recursive: true });
await copyFile(release, join(dir, "Praxis.exe"));
const child = spawn(join(dir, "Praxis.exe"), [], {
  windowsHide: true,
  stdio: "ignore",
  env: {
    ...process.env,
    PRAXIS_DATA_DIR: join(dir, "client"),
    WEBVIEW2_USER_DATA_FOLDER: join(dir, "webview"),
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:
      "--remote-debugging-port=9256 --remote-debugging-address=127.0.0.1",
  },
});
let b, p;
const checks = [],
  errors = [];
async function call(command, args) {
  return p.evaluate(
    ([c, a]) => window.__TAURI_INTERNALS__.invoke(c, a),
    [command, args],
  );
}
async function work() {
  return call("productivity_snapshot");
}
async function task(title) {
  return (await work()).tasks.find((t) => t.title === title);
}
async function more(name) {
  const menu = p.locator(".timeline-more");
  if ((await menu.getAttribute("open")) === null)
    await menu.locator("summary").click();
  await menu.getByRole("button", { name, exact: true }).click();
}
async function shot(name) {
  await p.screenshot({ path: join(evidence, name + ".png") });
}
async function closePanel() {
  await p.getByRole("button", { name: "关闭任务详情", exact: true }).click();
}
async function assertTask(title, patch) {
  await expect
    .poll(async () => {
      const t = await task(title);
      return Object.fromEntries(Object.keys(patch).map((k) => [k, t?.[k]]));
    })
    .toEqual(patch);
}
try {
  for (let i = 0; i < 80; i++) {
    try {
      b = await chromium.connectOverCDP("http://127.0.0.1:9256", {
        timeout: 500,
      });
      p = b.contexts()[0].pages()[0];
      await p
        .getByLabel("任务标题", { exact: true })
        .waitFor({ timeout: 1000 });
      break;
    } catch {
      await b?.close().catch(() => {});
      await wait(250);
    }
  }
  if (!p) throw Error("Desktop did not start");
  p.setDefaultTimeout(10000);
  // Fixture label only; task creation and editing below use visible native UI.
  await call("productivity_command", {
    command: {
      operationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      action: {
        type: "label",
        id: crypto.randomUUID(),
        name: "工作",
        expectedVersion: null,
      },
    },
  });
  const daily = "整理新版界面";
  await p.getByLabel("任务标题", { exact: true }).fill(daily);
  await p.getByLabel("任务标题", { exact: true }).press("Enter");
  await p.locator(".task-title", { hasText: daily }).click();
  await p.getByLabel("优先级", { exact: true }).selectOption("1");
  await assertTask(daily, { priority: 1 });
  await expect(p.getByLabel("编辑任务标题")).toBeEnabled();
  await p.locator(".task-panel-notes").fill("优先级修改后仍可连续编辑");
  await assertTask(daily, { notes: "优先级修改后仍可连续编辑", priority: 1 });
  await p.getByRole("checkbox", { name: "工作", exact: true }).check();
  await expect.poll(async () => (await task(daily)).labels.length).toBe(1);
  await expect(p.getByLabel("优先级", { exact: true })).toBeEnabled();
  await shot("01-unified-daily-panel");
  await closePanel();
  checks.push("daily priority, label and consecutive text autosave");
  await p.getByRole("button", { name: "快速任务", exact: true }).click();
  const dialog = p.getByRole("dialog", { name: "任务属性", exact: true });
  await expect(dialog.getByLabel("任务标题", { exact: true })).toBeFocused();
  await expect(dialog.getByLabel("优先级", { exact: true })).toBeHidden();
  await shot("02-quick-add");
  await dialog
    .getByLabel("任务标题", { exact: true })
    .fill("只输入标题即可添加");
  await dialog.getByLabel("任务标题", { exact: true }).press("Enter");
  await expect(dialog).toBeHidden();
  await expect
    .poll(
      async () =>
        (await work()).tasks.filter((t) => t.title === "只输入标题即可添加")
          .length,
    )
    .toBe(1);
  checks.push("quick add one field, Enter once, no preview or duplicate");
  await p.getByRole("button", { name: "快速任务", exact: true }).click();
  await dialog.getByLabel("任务标题", { exact: true }).fill("明天准备周报");
  await dialog.getByRole("button", { name: "明天", exact: true }).click();
  await dialog.getByRole("button", { name: "更多选项", exact: true }).click();
  await dialog.getByLabel("说明", { exact: true }).fill("展开和收起保留输入");
  await dialog.getByRole("button", { name: "收起选项", exact: true }).click();
  await dialog.getByRole("button", { name: "添加任务", exact: true }).click();
  await expect(dialog).toBeHidden();
  await assertTask("明天准备周报", { notes: "展开和收起保留输入" });
  expect((await task("明天准备周报")).plan.kind).toBe("date");
  checks.push("quick add date and optional draft preserved");
  await p.getByRole("button", { name: /^收件箱/ }).click();
  await p
    .locator(".inbox-task-title", { hasText: "只输入标题即可添加" })
    .click();
  await p.getByLabel("优先级", { exact: true }).selectOption("2");
  await assertTask("只输入标题即可添加", { priority: 2 });
  await expect(p.locator(".task-panel-notes")).toBeEnabled();
  await p.locator(".task-panel-notes").fill("收件箱统一编辑");
  await assertTask("只输入标题即可添加", {
    priority: 2,
    notes: "收件箱统一编辑",
  });
  await closePanel();
  checks.push("inbox shares property editor and remains editable");
  await p.getByRole("button", { name: "新建项目", exact: true }).click();
  await p.getByLabel("项目名称", { exact: true }).fill("新版体验验收");
  await p.getByLabel("预期结果", { exact: true }).fill("添加和编辑更轻松");
  await p.getByRole("button", { name: "保存项目", exact: true }).click();
  await p.getByLabel("项目任务标题", { exact: true }).fill("验证项目侧栏");
  await p.getByLabel("项目任务标题", { exact: true }).press("Enter");
  await expect(p.locator(".project-context-summary")).toHaveAttribute(
    "aria-expanded",
    "false",
  );
  await shot("03-compact-project");
  await p.locator(".project-task-title", { hasText: "验证项目侧栏" }).click();
  await p.getByLabel("优先级", { exact: true }).selectOption("3");
  await assertTask("验证项目侧栏", { priority: 3 });
  await expect(p.locator(".task-panel-notes")).toBeEnabled();
  await p.locator(".task-panel-notes").fill("项目任务统一编辑");
  await assertTask("验证项目侧栏", { priority: 3, notes: "项目任务统一编辑" });
  await shot("04-unified-project-panel");
  await closePanel();
  checks.push("project properties, text autosave and compact recovery card");
  await p.getByRole("link", { name: "今日与近期", exact: true }).click();
  await p.locator(".task-title", { hasText: daily }).click();
  await p.getByRole("button", { name: "更多属性与结构…", exact: true }).click();
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole("button", { name: "保存修改", exact: true }),
  ).toBeVisible();
  await dialog.getByLabel("任务标题", { exact: true }).fill("统一编辑保存一次");
  await dialog.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(dialog).toBeHidden();
  await assertTask("统一编辑保存一次", {
    priority: 1,
    notes: "优先级修改后仍可连续编辑",
  });
  checks.push("advanced editor saves ordinary fields in one step");
  await p.getByRole("button", { name: "快速任务", exact: true }).click();
  await dialog.getByLabel("任务标题", { exact: true }).fill("取消输入");
  await dialog
    .getByRole("button", { name: "关闭任务编辑", exact: true })
    .click();
  expect(await task("取消输入")).toBeUndefined();
  await expect(p.getByRole("button", {name:"快速任务", exact:true})).toBeFocused();
  checks.push("cancel does not create a task");
  await more("时区与标签");
  if (
    await p.getByRole("button", { name: "预览时区影响", exact: true }).count()
  ) {
    await p.getByRole("button", { name: "预览时区影响", exact: true }).click();
    await p
      .getByRole("button", { name: "确认工作空间时区", exact: true })
      .click();
  }
  await more("重复任务");
  await expect(p.locator(".weekday-options").first()).toBeVisible();
  await shot("05-weekday-controls");
  checks.push("weekday options use compact shared controls");
  const overflow = await p.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
  checks.push("no horizontal viewport overflow");
  console.log(JSON.stringify({ passed: checks.length, checks }));
} catch (e) {
  errors.push(String(e));
  await p?.screenshot({ path: join(evidence, "failure.png") }).catch(() => {});
  console.error(String(e));
  process.exitCode = 1;
} finally {
  await writeFile(
    join(evidence, "result.json"),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        release,
        isolated: true,
        workspace: join(dir, "client"),
        checks,
        errors,
      },
      null,
      2,
    ),
  );
  await b?.close().catch(() => {});
  child.kill();
}
