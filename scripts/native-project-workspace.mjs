import { expect } from "@playwright/test";
import { join } from "node:path";
export async function checkProjectWorkspace({
  app,
  launch,
  stop,
  evidence,
  results,
}) {
  const row = (title) =>
    app.page
      .locator(".tree-task")
      .filter({ has: app.page.locator("strong").filter({ hasText: title }) });
  const card = (title) =>
    app.page
      .locator(".kanban-card")
      .filter({ has: app.page.locator("strong").filter({ hasText: title }) });
  const tab = (name) => app.page.getByRole("tab", { name, exact: true });
  const project = () =>
    app.page.locator(".project-card").filter({ hasText: "三视图验收项目" });
  await app.page.getByRole("button", { name: "新建项目", exact: true }).click();
  await app.page.getByLabel("项目名称", { exact: true }).fill("三视图验收项目");
  await app.page
    .getByLabel("预期结果", { exact: true })
    .fill("验证生命周期、层级及三视图共用任务");
  await app.page.getByRole("button", { name: "保存项目", exact: true }).click();
  await app.page
    .getByLabel("拆成可以行动的任务")
    .fill("设计验证\n开发验证\n发布验证");
  await app.page
    .getByRole("button", { name: "添加项目任务", exact: true })
    .click();
  await expect(row("发布验证")).toBeVisible();
  await row("发布验证")
    .getByRole("button", { name: "上移任务", exact: true })
    .click();
  await expect
    .poll(() => app.page.locator(".tree-task strong").allTextContents())
    .toEqual(["设计验证", "发布验证", "开发验证"]);
  await row("发布验证")
    .getByRole("button", { name: "移动层级", exact: true })
    .click();
  await row("发布验证")
    .getByLabel("目标父任务")
    .selectOption({ label: "开发验证" });
  await row("发布验证")
    .getByRole("button", { name: "确认移动", exact: true })
    .click();
  await expect(row("开发验证")).toContainText("汇总 · 0 / 1");
  await row("发布验证")
    .getByRole("button", { name: "移动层级", exact: true })
    .click();
  await row("发布验证").getByLabel("目标父任务").selectOption("");
  await row("发布验证")
    .getByRole("button", { name: "确认移动", exact: true })
    .click();
  await expect(row("开发验证")).not.toContainText("汇总");
  results.push(
    "Task reorder and subtree move preserve task identity and allow promotion to root",
  );
  await row("设计验证")
    .getByRole("button", { name: "加入今日", exact: true })
    .click();
  await expect(
    row("设计验证").getByRole("button", { name: "查看安排", exact: true }),
  ).toBeVisible();
  await tab("看板").click();
  await card("设计验证").dragTo(
    app.page.locator('.kanban-column[data-status="in_progress"]'),
    { sourcePosition: { x: 20, y: 20 }, targetPosition: { x: 50, y: 45 } },
  );
  await expect(
    app.page.getByRole("form", { name: "确认状态变更" }),
  ).toContainText("设计验证");
  await app.page
    .getByRole("button", { name: "确认状态变更", exact: true })
    .click();
  await expect(
    app.page.locator('.kanban-column[data-status="in_progress"]'),
  ).toContainText("设计验证");
  await card("设计验证").getByLabel("切换状态").selectOption("blocked");
  await app.page.getByLabel("原因", { exact: true }).fill("等待设计材料");
  await app.page
    .getByRole("button", { name: "确认状态变更", exact: true })
    .click();
  await expect(
    app.page.locator('.kanban-column[data-status="blocked"]'),
  ).toContainText("等待设计材料");
  await card("开发验证").getByLabel("切换状态").selectOption("completed");
  await app.page
    .getByRole("button", { name: "确认状态变更", exact: true })
    .click();
  await expect(
    app.page.locator('.kanban-column[data-status="completed"]'),
  ).toContainText("开发验证");
  await card("发布验证").getByLabel("切换状态").selectOption("cancelled");
  await app.page.getByLabel("原因", { exact: true }).fill("等待确认范围");
  await app.page
    .getByRole("button", { name: "确认状态变更", exact: true })
    .click();
  await expect(card("发布验证")).toHaveCount(0);
  await app.page.getByRole("button", { name: /查看已取消任务/ }).click();
  await card("发布验证").getByLabel("切换状态").selectOption("restore");
  await app.page
    .getByRole("button", { name: "确认状态变更", exact: true })
    .click();
  await expect(
    app.page.locator('.kanban-column[data-status="todo"]'),
  ).toContainText("发布验证");
  await app.page.screenshot({ path: join(evidence, "desktop-kanban.png") });
  await app.page.getByRole("link", { name: /今日/ }).click();
  await expect(
    app.page.locator(".task-item").filter({ hasText: "设计验证" }),
  ).toContainText("等待设计材料");
  // Completion is visible on the real completion day even if the task had no prior plan.
  await app.page.getByRole("button", { name: /已完成/ }).click();
  await expect(
    app.page.locator(".task-item").filter({ hasText: "开发验证" }),
  ).toBeVisible();
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await project().click();
  results.push(
    "Native kanban drag/menu transitions share blocked reasons, completion facts and cancellation restoration with daily view",
  );
  const manage = async (state, choice = "keep") => {
    await app.page
      .getByRole("button", { name: "管理项目状态", exact: true })
      .click();
    await app.page.getByLabel("项目状态", { exact: true }).selectOption(state);
    await app.page.getByLabel("追踪项目", { exact: true }).check();
    if (["paused", "archived"].includes(state))
      await app.page.getByLabel("已有每日安排").selectOption(choice);
    await app.page
      .getByRole("button", { name: "保存项目状态", exact: true })
      .click();
    await expect(
      app.page.getByRole("form", { name: "项目生命周期" }),
    ).toHaveCount(0);
  };
  await manage("paused");
  await app.page.getByRole("link", { name: /今日/ }).click();
  await expect(
    app.page.locator(".task-item").filter({ hasText: "设计验证" }),
  ).toContainText("项目暂停");
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await project().click();
  await manage("archived", "remove");
  await app.page.getByRole("button", { name: "归档项目", exact: true }).click();
  await expect(project()).toBeVisible();
  await app.page.getByRole("link", { name: /今日/ }).click();
  await expect(
    app.page.locator(".task-item").filter({ hasText: "设计验证" }),
  ).toHaveCount(0);
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await app.page.getByRole("button", { name: "归档项目", exact: true }).click();
  await project().click();
  await manage("active");
  await app.page.getByRole("button", { name: "追踪项目", exact: true }).click();
  await expect(project()).toBeVisible();
  await tab("任务视图").click();
  await row("设计验证")
    .getByRole("button", { name: "加入今日", exact: true })
    .click();
  await expect(
    row("设计验证").getByRole("button", { name: "查看安排", exact: true }),
  ).toBeVisible();
  results.push(
    "Project pause retains visible commitments; archive removal preserves completed history; focus/archive filters and explicit rescheduling work",
  );
  await tab("甘特图").click();
  const dates = await app.page.evaluate(() => {
    const d = new Date();
    const result = [];
    for (let i = 0; i < 9; i++) {
      const n = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
      result.push(
        [
          n.getFullYear(),
          String(n.getMonth() + 1).padStart(2, "0"),
          String(n.getDate()).padStart(2, "0"),
        ].join("-"),
      );
    }
    return result;
  });
  async function editSchedule(title, start, end, dependency) {
    await app.page
      .locator(".gantt-task-picker")
      .getByRole("button", { name: title, exact: true })
      .first()
      .click();
    await app.page.getByLabel("计划开始日", { exact: true }).fill(start);
    await app.page.getByLabel("计划结束日", { exact: true }).fill(end);
    if (dependency)
      await app.page
        .getByRole("group", { name: "前置任务（完成后开始）" })
        .getByLabel(dependency, { exact: true })
        .check();
    await app.page
      .getByRole("button", { name: "预览排期调整", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "确认应用排期", exact: true })
      .click();
    await expect(
      app.page.getByRole("form", { name: "编辑甘特排期" }),
    ).toHaveCount(0);
  }
  await editSchedule("设计验证", dates[1], dates[2]);
  await editSchedule("开发验证", dates[3], dates[4], "设计验证");
  await expect(app.page.locator(".schedule-warning")).toContainText("设计验证");
  const bar = app.page.getByRole("button", {
    name: "编辑排期：设计验证",
    exact: true,
  });
  await bar.scrollIntoViewIfNeeded();
  let box = await bar.boundingBox();
  await app.page.mouse.move(box.x + 10, box.y + 10);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + 74, box.y + 10, { steps: 5 });
  await app.page.mouse.up();
  await expect(
    app.page.getByRole("region", { name: "排期调整预览" }),
  ).toContainText("开发验证");
  await app.page.getByRole("button", { name: "取消预览", exact: true }).click();
  await expect(bar.locator("title")).toContainText(dates[1]);
  box = await bar.boundingBox();
  await app.page.mouse.move(box.x + 10, box.y + 10);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + 74, box.y + 10, { steps: 5 });
  await app.page.mouse.up();
  await app.page
    .getByRole("button", { name: "确认应用排期", exact: true })
    .click();
  await expect(bar.locator("title")).toContainText(dates[3]);
  // Delay real native replies through Tauri's documented-in-source debug callback map.
  await holdNativeReplies(app.page);
  await app.page
    .getByRole("button", { name: "撤销上次排期", exact: true })
    .click();
  await expect
    .poll(() => app.page.evaluate(() => window.__heldWorkspaceReply))
    .toBe(true);
  await expect(
    app.page.getByRole("button", { name: "撤销上次排期", exact: true }),
  ).toBeDisabled();
  await app.page
    .locator(".gantt-scroll text")
    .filter({ hasText: "发布验证" })
    .click();
  await bar.press("Enter");
  await expect(
    app.page.getByRole("form", { name: "编辑甘特排期" }),
  ).toHaveCount(0);
  await app.page.evaluate(() => window.__releaseWorkspaceReply());
  await expect(bar.locator("title")).toContainText(dates[1]);
  await app.page
    .locator(".gantt-task-picker details")
    .getByText("编辑任意叶子任务的日期与依赖", { exact: true })
    .click();
  await app.page
    .locator(".gantt-task-picker details")
    .getByRole("button", { name: "设计验证", exact: true })
    .click();
  await app.page
    .getByRole("group", { name: "前置任务（完成后开始）" })
    .getByLabel("开发验证", { exact: true })
    .check();
  await app.page
    .getByRole("button", { name: "预览排期调整", exact: true })
    .click();
  await expect(app.page.getByRole("alert")).toContainText("循环");
  await app.page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await app.page.screenshot({ path: join(evidence, "desktop-gantt.png") });
  results.push(
    "Gantt edit and native bar drag preview dependent shifts, preserve daily dates, support cancel/undo and reject cycles",
  );
  stop(app.child);
  app = await launch();
  await app.page.getByRole("button", { name: "项目", exact: true }).click();
  await project().click();
  await expect(app.page.locator(".state-badge")).toContainText("追踪项目");
  await tab("甘特图").click();
  await expect(
    app.page
      .getByRole("button", { name: "编辑排期：设计验证", exact: true })
      .locator("title"),
  ).toContainText(dates[1]);
  await tab("看板").click();
  await expect(
    app.page.locator('.kanban-column[data-status="blocked"]'),
  ).toContainText("等待设计材料");
  results.push(
    "Lifecycle, ordering, task state, schedule and dependencies survive abrupt native restart",
  );

  const shortcut = () =>
    app.page
      .getByRole("region", { name: "追踪项目快捷入口" })
      .getByRole("button", { name: /三视图验收项目/ });
  await expect(shortcut()).toBeVisible();
  await app.page.getByRole("link", { name: /今日/ }).click();
  await shortcut().click();
  await expect(app.page.locator(".project-heading h2")).toHaveText(
    "三视图验收项目",
  );
  await expect(
    app.page.locator(
      ".projects-view .topbar,.projects-view .eyebrow,.projects-view .intro",
    ),
  ).toHaveCount(0);
  await app.page.getByRole("button", { name: "新建项目", exact: true }).click();
  await app.page.getByLabel("项目名称", { exact: true }).fill("未保存的草稿");
  await shortcut().click();
  await expect(
    app.page.getByRole("form", { name: "项目基本信息" }),
  ).toHaveCount(0);
  await app.page.getByRole("button", { name: "编辑项目", exact: true }).click();
  await holdNativeReplies(app.page);
  await app.page.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect
    .poll(() => app.page.evaluate(() => window.__heldWorkspaceReply))
    .toBe(true);
  await expect(shortcut()).toBeDisabled();
  await app.page.evaluate(() => window.__releaseWorkspaceReply());
  await expect(shortcut()).toBeEnabled();
  await expect(
    app.page.getByRole("form", { name: "项目基本信息" }),
  ).toHaveCount(0);
  await app.page
    .getByRole("button", { name: "管理项目状态", exact: true })
    .click();
  await app.page.getByLabel("追踪项目", { exact: true }).uncheck();
  await app.page
    .getByRole("button", { name: "保存项目状态", exact: true })
    .click();
  await expect(shortcut()).toHaveCount(0);
  await manage("active");
  await expect(shortcut()).toBeVisible();
  const toolbar = await app.page.locator(".project-toolbar").boundingBox();
  const layout = await app.page.locator(".project-layout").boundingBox();
  expect(toolbar.height).toBeLessThan(80);
  expect(layout.y).toBeLessThan(150);
  await app.page.screenshot({
    path: join(evidence, "desktop-tracked-projects.png"),
  });
  results.push(
    "Tracked projects persist in sidebar, open the selected workspace, clear new-project drafts and prevent navigation during save; compact toolbar frees primary space",
  );

  return app;
}

async function holdNativeReplies(page) {
  await page.evaluate(() => {
    const callbacks = window.__TAURI_INTERNALS__.callbacks;
    const original = callbacks.set;
    const pending = [];
    window.__heldWorkspaceReply = false;
    callbacks.set = function (id, callback) {
      return original.call(this, id, (data) => {
        window.__heldWorkspaceReply = true;
        pending.push(() => callback(data));
      });
    };
    window.__releaseWorkspaceReply = () => {
      callbacks.set = original;
      for (const reply of pending) reply();
    };
  });
}
