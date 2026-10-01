import { expect } from "@playwright/test";
import { chooseDate } from "./native-date-controls.mjs";
import { join } from "node:path";

export async function checkProjectRowDrag(app, evidence) {
  const page = app.page;
  const row = (title) =>
    page
      .locator(".tree-task")
      .filter({
        has: page.locator(".project-task-title").filter({ hasText: title }),
      });
  const order = () =>
    page.locator(".tree-task .project-task-title").allTextContents();
  const drag = async (from, to, position) => {
    await expect(row(from)).toHaveAttribute("draggable", "true");
    await expect(row(to).locator(".project-task-title")).toBeEnabled();
    const b = await row(to).boundingBox();
    await row(from)
      .locator(".project-task-title")
      .dragTo(row(to), {
        targetPosition: {
          x: 90,
          y:
            position === "inside"
              ? b.height / 2
              : position === "before"
                ? 3
                : b.height - 3,
        },
      });
  };
  await page.getByRole("button", { name: "新建项目", exact: true }).click();
  await page.getByLabel("项目名称", { exact: true }).fill("任务拖动与紧凑排期");
  await page
    .getByLabel("预期结果", { exact: true })
    .fill("拖动整行、跨层级和子树");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  for (const title of ["设计阶段", "开发阶段", "验收工作"]) {
    await page.getByLabel("项目任务标题", { exact: true }).fill(title);
    await page.getByLabel("项目任务标题", { exact: true }).press("Enter");
    await expect(row(title)).toBeVisible();
  }
  await drag("设计阶段", "开发阶段", "after");
  await expect.poll(order).toEqual(["开发阶段", "设计阶段", "验收工作"]);
  await drag("验收工作", "设计阶段", "inside");
  await expect(row("设计阶段").locator(".task-meta")).toHaveText("0 / 1");
  await drag("设计阶段", "验收工作", "inside");
  await expect.poll(order).toEqual(["开发阶段", "设计阶段", "验收工作"]);
  await expect(page.locator(".is-dragging,.drop-inside")).toHaveCount(0);
  await drag("设计阶段", "开发阶段", "before");
  await expect.poll(order).toEqual(["设计阶段", "验收工作", "开发阶段"]);
  await drag("验收工作", "开发阶段", "after");
  await expect.poll(order).toEqual(["设计阶段", "开发阶段", "验收工作"]);
  await expect(row("设计阶段").locator(".task-meta")).toHaveCount(0);
  await row("开发阶段")
    .getByRole("button", { name: "更多操作：开发阶段", exact: true })
    .click();
  await page
    .getByRole("group", { name: "更多操作：开发阶段", exact: true })
    .getByRole("button", { name: "加入今日", exact: true })
    .click();
  await expect(row("开发阶段").locator(".task-meta")).toContainText(/2026-/);
  await page.keyboard.press("Escape");
  await drag("验收工作", "开发阶段", "inside");
  const confirm = page.getByRole("group", {
    name: "确认移动为子任务",
    exact: true,
  });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "取消移动", exact: true }).click();
  await expect(row("开发阶段").locator(".task-meta")).not.toHaveText("0 / 1");
  await drag("验收工作", "开发阶段", "inside");
  await confirm.getByRole("button", { name: "确认移动", exact: true }).click();
  await expect(row("开发阶段").locator(".task-meta")).toHaveText("0 / 1");
  await expect(confirm).toHaveCount(0);
  await page.getByRole("tab", { name: "甘特图", exact: true }).click();
  await expect(
    page.getByText("未排期 · 点击安排", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "编辑任务排期：验收工作", exact: true })
    .click();
  const editor = page.getByRole("form", { name: "编辑甘特排期", exact: true });
  expect((await editor.boundingBox()).height).toBeLessThan(190);
  await page.screenshot({ path: join(evidence, "compact-project-gantt.png") });
  await chooseDate(page, "计划开始日", "2026-10-03");
  await chooseDate(page, "计划结束日", "2026-10-04");
  await editor.getByRole("button", { name: "保存排期", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "编辑排期：验收工作", exact: true }),
  ).toBeVisible();
}
