import { chromium, expect } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";

const browser = await chromium.connectOverCDP("http://127.0.0.1:9223");
const page = browser.contexts()[0].pages()[0];
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("dialog", (dialog) => dialog.accept());
const stamp = Date.now().toString().slice(-7),
  project = `手机验收项目 ${stamp}`,
  task = `准备演示 ${stamp}`;
const evidence = new URL("../docs/evidence/mobile/", import.meta.url);
await mkdir(evidence, { recursive: true });
async function route(name) {
  await page.getByRole("button", { name: "打开菜单", exact: true }).click();
  await page
    .getByRole("navigation", { name: "功能菜单" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function saveDialog() {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
}
try {
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "任务清单", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开收件箱", exact: true }).click();
  await expect(
    page.getByText("【安装验证】Praxis 模拟器测试", { exact: false }),
  ).toBeVisible();
  await page
    .getByLabel("记下原文", { exact: true })
    .fill(`手机原文 ${stamp}\n保留中文与换行`);
  await page.getByRole("button", { name: "保存原文", exact: true }).click();
  await expect(page.getByLabel("记下原文", { exact: true })).toHaveValue("");
  const capture = page
    .locator(".pm-capture")
    .filter({ hasText: `手机原文 ${stamp}` });
  await capture.getByRole("button", { name: "预览澄清", exact: true }).click();
  await page.getByRole("button", { name: "确认澄清", exact: true }).click();
  await expect(
    capture.getByRole("button", { name: "撤销澄清", exact: true }),
  ).toBeVisible();
  await capture.getByRole("button", { name: "撤销澄清", exact: true }).click();
  await expect(
    capture.getByRole("button", { name: "预览澄清", exact: true }),
  ).toBeVisible();
  await route("项目");
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill(project);
  await saveDialog();
  await page
    .locator(".pm-project")
    .filter({ hasText: project })
    .getByRole("button")
    .first()
    .click();
  await page.getByRole("button", { name: "新建任务", exact: true }).click();
  await page.getByRole("dialog").getByLabel("名称", { exact: true }).fill(task);
  await saveDialog();
  await page
    .getByRole("button", { name: `添加子任务：${task}`, exact: true })
    .click();
  await page
    .getByRole("dialog")
    .getByLabel("名称", { exact: true })
    .fill(`确认素材 ${stamp}`);
  await saveDialog();
  await page.getByRole("button", { name: /展开 1 个子任务/ }).click();
  await page
    .getByRole("button", { name: `完成：确认素材 ${stamp}`, exact: true })
    .click();
  await expect(
    page.getByRole("button", {
      name: `撤销完成：确认素材 ${stamp}`,
      exact: true,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: `完成：${task}`, exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: `撤销完成：${task}`, exact: true }),
  ).toBeVisible();
  await route("任务清单");
  await expect(
    page.getByRole("button", { name: `撤销完成：${task}`, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: new URL("tasks.png", evidence).pathname.replace(/^\/(\w:)/, "$1"),
    fullPage: true,
  });
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth > innerWidth + 1,
  );
  if (overflow) throw new Error("Mobile page overflows horizontally");
  await route("习惯");
  await page.getByLabel("习惯名称", { exact: true }).fill(`阅读 ${stamp}`);
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: `阅读 ${stamp}`, exact: true }),
  ).toBeVisible();
  await page
    .locator(".mobile-extras article")
    .filter({ hasText: `阅读 ${stamp}` })
    .getByRole("button", { name: "完成", exact: true })
    .click();
  await route("我的");
  await page
    .getByRole("button", { name: "生成完整本机 JSON", exact: true })
    .click();
  await expect(page.locator(".mx-json")).toHaveValue(/praxis-mobile-workspace/);
  const exported = await page.locator(".mx-json").inputValue();
  const data = JSON.parse(exported);
  if (!data.entities.some((e) => e.kind === "task" && e.data.title === task))
    throw new Error("Export omitted task");
  await writeFile(
    new URL("smoke.json", evidence),
    JSON.stringify(
      {
        stamp,
        project,
        task,
        checks: [
          "v2 capture preserved",
          "capture create/clarify/undo",
          "project/task/subtask",
          "complete child and parent",
          "today list",
          "habit check",
          "JSON export",
          "no horizontal overflow",
        ],
        errors,
        entityCount: data.entities.length,
      },
      null,
      2,
    ),
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS mobile smoke", {
    stamp,
    project,
    task,
    entityCount: data.entities.length,
  });
} catch (error) {
  await page.screenshot({
    path: new URL("failure.png", evidence).pathname.replace(/^\/(\w:)/, "$1"),
    fullPage: true,
  });
  console.error((await page.locator("body").innerText()).slice(-5000));
  throw error;
} finally {
  await browser.close();
}
