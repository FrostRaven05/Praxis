import { checkProjectRowDrag } from "./native-project-drag.mjs";
import { expect } from "@playwright/test";
import { chooseDate } from "./native-date-controls.mjs";
import { join } from "node:path";
export async function checkProjectWorkspace({
  app,
  launch,
  stop,
  evidence,
  results,
}) {
  const row = (title) =>
    app.page.locator(".tree-task").filter({
      has: app.page.locator(".project-task-title").filter({ hasText: title }),
    });
  const card = (title) =>
    app.page.locator(".kanban-card").filter({
      has: app.page.locator(".kanban-task-title").filter({ hasText: title }),
    });
  const actions = async (title) => {
    const label = "更多操作：" + title;
    const trigger = row(title).getByRole("button", {
      name: label,
      exact: true,
    });
    if ((await trigger.getAttribute("aria-expanded")) !== "true")
      await trigger.click();
    return app.page.getByRole("group", { name: label, exact: true });
  };
  const boardActions = async (title) => {
    const label = "更多操作：" + title;
    const trigger = card(title).getByRole("button", {
      name: label,
      exact: true,
    });
    if ((await trigger.getAttribute("aria-expanded")) !== "true")
      await trigger.click();
    return app.page.getByRole("group", { name: label, exact: true });
  };
  const tab = (name) => app.page.getByRole("tab", { name, exact: true });
  const projectOptions = async () => {
    const trigger = app.page.getByRole("button", {
      name: "项目选项",
      exact: true,
    });
    if ((await trigger.getAttribute("aria-expanded")) !== "true")
      await trigger.click();
    return app.page.getByRole("group", { name: "项目选项", exact: true });
  };
  const project = () =>
    app.page.locator(".project-card").filter({ hasText: "三视图验收项目" });
  await app.page.getByRole("button", { name: "新建项目", exact: true }).click();
  await app.page.getByLabel("项目名称", { exact: true }).fill("三视图验收项目");
  await app.page
    .getByLabel("预期结果", { exact: true })
    .fill("验证生命周期、层级及三视图共用任务");
  await app.page.getByRole("button", { name: "保存项目", exact: true }).click();
  for (const title of ["设计验证", "开发验证", "发布验证"]) {
    const input = app.page.getByLabel("项目任务标题", { exact: true });
    await input.fill(title);
    await input.press("Enter");
    await expect(row(title)).toBeVisible();
    await expect(input).toBeFocused();
  }
  await expect(row("发布验证")).toBeVisible();
  await (
    await actions("发布验证")
  )
    .getByRole("button", { name: "上移任务", exact: true })
    .click();
  await expect
    .poll(() =>
      app.page.locator(".tree-task .project-task-title").allTextContents(),
    )
    .toEqual(["设计验证", "发布验证", "开发验证"]);
  const reorderedTaskId = await row("发布验证").getAttribute("data-task-id");
  const siblingBox = await row("开发验证").boundingBox();
  expect(siblingBox).toBeTruthy();
  await row("发布验证")
    .locator(".project-task-grip")
    .dragTo(row("开发验证"), {
      targetPosition: {
        x: Math.min(80, siblingBox.width - 8),
        y: siblingBox.height - 4,
      },
    });
  await expect
    .poll(() =>
      app.page.locator(".tree-task .project-task-title").allTextContents(),
    )
    .toEqual(["设计验证", "开发验证", "发布验证"]);
  await expect(row("发布验证")).toHaveAttribute(
    "data-task-id",
    reorderedTaskId,
  );
  await (
    await actions("发布验证")
  )
    .getByRole("button", { name: "移动层级", exact: true })
    .click();
  await (
    await actions("发布验证")
  )
    .getByLabel("目标父任务")
    .selectOption({ label: "开发验证" });
  await (
    await actions("发布验证")
  )
    .getByRole("button", { name: "确认移动", exact: true })
    .click();
  await expect(row("开发验证").locator(".task-meta")).toHaveText("0 / 1");
  await row("开发验证")
    .getByRole("button", { name: "收起子任务：开发验证", exact: true })
    .click();
  await expect(row("发布验证")).toHaveCount(0);
  await expect(row("开发验证").locator(".task-meta")).toHaveText("0 / 1");
  await row("开发验证")
    .getByRole("button", { name: "展开子任务：开发验证", exact: true })
    .click();
  await expect(row("发布验证")).toBeVisible();
  await (
    await actions("发布验证")
  )
    .getByRole("button", { name: "移动层级", exact: true })
    .click();
  await (await actions("发布验证")).getByLabel("目标父任务").selectOption("");
  await (
    await actions("发布验证")
  )
    .getByRole("button", { name: "确认移动", exact: true })
    .click();
  await expect(row("开发验证").locator(".task-meta")).toHaveCount(0);
  results.push(
    "Task reorder, subtree move and child folding preserve task identity, leaf counts and promotion to root",
  );
  await (
    await actions("设计验证")
  )
    .getByRole("button", { name: "加入今日", exact: true })
    .click();
  await expect(
    (await actions("设计验证")).getByRole("button", {
      name: "查看安排",
      exact: true,
    }),
  ).toBeVisible();
  await tab("看板").click();
  await card("设计验证").dragTo(
    app.page.locator('.kanban-column[data-status="in_progress"]'),
    { sourcePosition: { x: 20, y: 20 }, targetPosition: { x: 50, y: 45 } },
  );
  await expect(
    app.page.locator('.kanban-column[data-status="in_progress"]'),
  ).toContainText("设计验证");
  await expect(app.page.locator(".kanban-reason-form")).toHaveCount(0);
  await (
    await boardActions("设计验证")
  )
    .getByRole("button", { name: "移到阻塞", exact: true })
    .click();
  const blockedReason = app.page.getByRole("form", {
    name: "阻塞原因",
    exact: true,
  });
  await blockedReason.getByRole("textbox").fill("等待设计材料");
  await blockedReason
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(
    app.page.locator('.kanban-column[data-status="blocked"]'),
  ).toContainText("等待设计材料");
  await (
    await boardActions("开发验证")
  )
    .getByRole("button", { name: "标为完成", exact: true })
    .click();
  await expect(
    app.page.locator('.kanban-column[data-status="completed"]'),
  ).toContainText("开发验证");
  await (
    await boardActions("发布验证")
  )
    .getByRole("button", { name: "取消任务", exact: true })
    .click();
  const cancelledReason = app.page.getByRole("form", {
    name: "取消任务原因",
    exact: true,
  });
  await cancelledReason.getByRole("textbox").fill("等待确认范围");
  await cancelledReason
    .getByRole("button", { name: "保存", exact: true })
    .click();
  await expect(card("发布验证")).toHaveCount(0);
  await (
    await projectOptions()
  )
    .getByRole("button", { name: "显示已取消任务", exact: true })
    .click();
  await expect(card("发布验证")).toContainText("等待确认范围");
  await (
    await boardActions("发布验证")
  )
    .getByRole("button", { name: "恢复任务", exact: true })
    .click();
  await expect(
    app.page.locator('.kanban-column[data-status="todo"]'),
  ).toContainText("发布验证");
  await expect(app.page.locator(".kanban-reason-form")).toHaveCount(0);
  await app.page
    .getByLabel("项目任务标题", { exact: true })
    .fill("看板快速输入验证");
  await app.page.getByLabel("项目任务标题", { exact: true }).press("Enter");
  await expect(card("看板快速输入验证")).toBeVisible();
  await expect(
    app.page.getByLabel("项目任务标题", { exact: true }),
  ).toBeFocused();
  const boardCapturedId =
    await card("看板快速输入验证").getAttribute("data-task-id");
  expect(boardCapturedId).toBeTruthy();
  await tab("任务视图").click();
  await expect(row("看板快速输入验证")).toHaveAttribute(
    "data-task-id",
    boardCapturedId,
  );
  await expect(row("开发验证")).toHaveCount(0);
  await (
    await projectOptions()
  )
    .getByRole("button", { name: "显示已完成任务", exact: true })
    .click();
  await expect(row("开发验证")).toBeVisible();
  await (
    await projectOptions()
  )
    .getByRole("button", { name: "隐藏已完成任务", exact: true })
    .click();
  await expect(row("开发验证")).toHaveCount(0);
  await tab("看板").click();
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
  await project().click();
  results.push(
    "Native kanban drag/menu transitions commit ordinary states directly, retain reason confirmation and share facts with daily view; capture shares task identity and list completion filters work",
  );
  const manage = async (state, choice = "keep") => {
    await (
      await projectOptions()
    )
      .getByRole("button", { name: "编辑项目", exact: true })
      .click();
    await app.page
      .getByRole("button", { name: "管理项目状态", exact: true })
      .click();
    await app.page.getByLabel("项目状态", { exact: true }).selectOption(state);
    if (["paused", "archived"].includes(state))
      await app.page.getByLabel("已有每日安排").selectOption(choice);
    await app.page
      .getByRole("button", { name: "保存项目状态", exact: true })
      .click();
    await expect(
      app.page.getByRole("form", { name: "项目生命周期" }),
    ).toHaveCount(0);
    await app.page
      .getByRole("form", { name: "项目基本信息" })
      .getByRole("button", { name: "取消", exact: true })
      .click();
  };
  await manage("paused");
  await app.page.getByRole("link", { name: /今日/ }).click();
  await expect(
    app.page.locator(".task-item").filter({ hasText: "设计验证" }),
  ).toContainText("项目暂停");
  await project().click();
  await manage("archived", "remove");
  await expect(project()).toHaveCount(0);
  await app.page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(
    app.page.getByRole("button", {
      name: "查看归档项目：三视图验收项目",
      exact: true,
    }),
  ).toBeVisible();
  await app.page.getByRole("link", { name: /今日/ }).click();
  await expect(
    app.page.locator(".task-item").filter({ hasText: "设计验证" }),
  ).toHaveCount(0);
  await app.page.getByRole("button", { name: "设置", exact: true }).click();
  await app.page
    .getByRole("button", { name: "查看归档项目：三视图验收项目", exact: true })
    .click();
  await manage("active");
  await expect(project()).toBeVisible();
  await tab("任务视图").click();
  await (
    await actions("设计验证")
  )
    .getByRole("button", { name: "加入今日", exact: true })
    .click();
  await expect(
    (await actions("设计验证")).getByRole("button", {
      name: "查看安排",
      exact: true,
    }),
  ).toBeVisible();
  results.push(
    "Project pause retains visible commitments; archived projects open from Settings and return to the sidebar when restored; explicit rescheduling works",
  );
  await tab("甘特图").click();
  await app.page
    .getByLabel("项目任务标题", { exact: true })
    .fill("甘特快速输入验证");
  await app.page.getByLabel("项目任务标题", { exact: true }).press("Enter");
  await expect(
    app.page.getByRole("button", {
      name: "编辑任务排期：甘特快速输入验证",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    app.page.getByLabel("项目任务标题", { exact: true }),
  ).toBeFocused();
  await tab("任务视图").click();
  const ganttCapturedId =
    await row("甘特快速输入验证").getAttribute("data-task-id");
  expect(ganttCapturedId).toBeTruthy();
  await tab("看板").click();
  await expect(card("甘特快速输入验证")).toHaveAttribute(
    "data-task-id",
    ganttCapturedId,
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
      .getByRole("button", { name: "编辑任务排期：" + title, exact: true })
      .click();
    await chooseDate(app.page, "计划开始日", start);
    await chooseDate(app.page, "计划结束日", end);
    if (dependency) {
      await app.page.locator(".gantt-dependencies summary").click();
      await app.page
        .getByRole("group", { name: "前置任务（完成后开始）" })
        .getByLabel(dependency, { exact: true })
        .check();
    }
    await app.page
      .getByRole("button", { name: "保存排期", exact: true })
      .click();
    await expect(
      app.page.getByRole("form", { name: "编辑甘特排期" }),
    ).toHaveCount(0);
    await expect(
      app.page.getByRole("region", { name: "排期调整预览" }),
    ).toHaveCount(0);
  }
  await app.page
    .getByRole("button", { name: "甘特图选项", exact: true })
    .click();
  await app.page
    .getByRole("button", { name: "时间轴起日", exact: true })
    .click();
  const anchorPicker = app.page.getByRole("dialog", {
    name: "时间轴起日选择器",
    exact: true,
  });
  await expect(anchorPicker).toBeVisible();
  await expect(
    anchorPicker.locator("input,.calendar-footer,.calendar-manual"),
  ).toHaveCount(0);
  expect(
    await anchorPicker.evaluate((e) => !!e.closest(".task-action-popover")),
  ).toBe(true);
  await app.page.keyboard.press("Escape");
  await expect(anchorPicker).toHaveCount(0);
  await expect(
    app.page.getByRole("group", { name: "甘特图选项", exact: true }),
  ).toBeVisible();
  await chooseDate(app.page, "时间轴起日", dates[8]);
  await expect(
    app.page.getByRole("group", { name: "甘特图选项", exact: true }),
  ).toBeVisible();
  await chooseDate(app.page, "时间轴起日", dates[0]);
  await app.page
    .getByRole("button", { name: "甘特图选项", exact: true })
    .click();
  await editSchedule("设计验证", dates[1], dates[2]);
  await editSchedule("开发验证", dates[3], dates[4], "设计验证");
  await expect(
    app.page.getByRole("region", { name: "每日安排对照", exact: true }),
  ).toHaveCount(0);
  await app.page
    .getByRole("button", { name: "甘特图选项", exact: true })
    .click();
  await app.page
    .getByRole("group", { name: "甘特图选项", exact: true })
    .getByRole("button", { name: /^每日安排对照 · / })
    .click();
  await expect(
    app.page.getByRole("region", { name: "每日安排对照", exact: true }),
  ).toContainText("设计验证");
  await app.page
    .getByRole("region", { name: "每日安排对照", exact: true })
    .getByRole("button", { name: "收起", exact: true })
    .click();
  const dragSchedule = async (title, dayDelta) => {
    const target = app.page.getByRole("button", {
      name: "编辑排期：" + title,
      exact: true,
    });
    await target.scrollIntoViewIfNeeded();
    const box = await target.boundingBox();
    expect(box).toBeTruthy();
    // Derive the displayed day width from adjacent SVG grid lines so zoom is respected.
    const dayWidth = await app.page
      .locator(".gantt-scroll")
      .evaluate((element) => {
        const lines = element.querySelectorAll(".gantt-grid-line");
        return (
          Number(lines[1].getAttribute("x1")) -
          Number(lines[0].getAttribute("x1"))
        );
      });
    await app.page.mouse.move(box.x + 10, box.y + 10);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + 10 + dayDelta * dayWidth, box.y + 10, {
      steps: 5,
    });
    await app.page.mouse.up();
  };
  await editSchedule("甘特快速输入验证", dates[5], dates[5]);
  await dragSchedule("甘特快速输入验证", 1);
  await expect(
    app.page
      .getByRole("button", { name: "编辑排期：甘特快速输入验证", exact: true })
      .locator("title"),
  ).toContainText(dates[6]);
  await expect(
    app.page.getByRole("region", { name: "排期调整预览" }),
  ).toHaveCount(0);
  const bar = app.page.getByRole("button", {
    name: "编辑排期：设计验证",
    exact: true,
  });
  await dragSchedule("设计验证", 2);
  await expect(
    app.page.getByRole("region", { name: "排期调整预览" }),
  ).toContainText("开发验证");
  await app.page.getByRole("button", { name: "取消预览", exact: true }).click();
  await expect(bar.locator("title")).toContainText(dates[1]);
  await dragSchedule("设计验证", 2);
  await app.page
    .getByRole("button", { name: "确认应用排期", exact: true })
    .click();
  await expect(bar.locator("title")).toContainText(dates[3]);
  await expect(
    app.page
      .getByRole("button", { name: "编辑排期：开发验证", exact: true })
      .locator("title"),
  ).toContainText(dates[5]);
  await app.page
    .getByRole("button", { name: "编辑任务排期：设计验证", exact: true })
    .click();
  const scheduleEditor = app.page.getByRole("form", { name: "编辑甘特排期" });
  await expect(scheduleEditor.locator(".gantt-dependencies")).toHaveJSProperty(
    "open",
    false,
  );
  await chooseDate(app.page, "计划开始日", dates[1]);
  await chooseDate(app.page, "计划结束日", dates[2]);
  // Delay real native replies through Tauri's documented-in-source debug callback map.
  await holdNativeReplies(app.page);
  await scheduleEditor
    .getByRole("button", { name: "保存排期", exact: true })
    .click();
  await expect
    .poll(() => app.page.evaluate(() => window.__heldWorkspaceReply))
    .toBe(true);
  await expect(
    scheduleEditor.getByRole("button", { name: "保存中…", exact: true }),
  ).toBeDisabled();
  const otherSchedule = app.page.getByRole("button", {
    name: "编辑任务排期：发布验证",
    exact: true,
  });
  await expect(otherSchedule).toHaveAttribute("aria-disabled", "true");
  await otherSchedule.click({ force: true });
  await bar.press("Enter");
  await expect(scheduleEditor.locator("h3")).toHaveText("设计验证");
  await app.page.evaluate(() => window.__releaseWorkspaceReply());
  await expect(scheduleEditor).toHaveCount(0);
  await expect(bar.locator("title")).toContainText(dates[1]);
  await app.page
    .getByRole("button", { name: "编辑任务排期：设计验证", exact: true })
    .click();
  await app.page.locator(".gantt-dependencies summary").click();
  await app.page
    .getByRole("group", { name: "前置任务（完成后开始）" })
    .getByLabel("开发验证", { exact: true })
    .check();
  await app.page.getByRole("button", { name: "保存排期", exact: true }).click();
  await expect(app.page.getByRole("alert")).toContainText("循环");
  await app.page.getByRole("button", { name: "取消编辑", exact: true }).click();
  await app.page.screenshot({ path: join(evidence, "desktop-gantt.png") });
  results.push(
    "Gantt capture, single-item edits and ordinary drags save directly; dependent shifts preview, cancel or apply; concurrent editing is locked, daily arrangements remain separate and cycles are rejected",
  );
  stop(app.child);
  app = await launch();
  await project().click();
  await expect(app.page.locator(".project-heading h2")).toHaveText(
    "三视图验收项目",
  );
  await expect(project()).toBeVisible();
  await expect(row("发布验证")).toHaveAttribute(
    "data-task-id",
    reorderedTaskId,
  );
  await expect
    .poll(() =>
      app.page.locator(".tree-task .project-task-title").allTextContents(),
    )
    .toEqual(["设计验证", "发布验证", "看板快速输入验证", "甘特快速输入验证"]);
  await tab("甘特图").click();
  await expect(
    app.page
      .getByRole("button", { name: "编辑排期：设计验证", exact: true })
      .locator("title"),
  ).toContainText(dates[1]);
  await expect(
    app.page
      .getByRole("button", { name: "编辑排期：开发验证", exact: true })
      .locator("title"),
  ).toContainText(dates[5]);
  await expect(
    app.page
      .getByRole("button", { name: "编辑排期：甘特快速输入验证", exact: true })
      .locator("title"),
  ).toContainText(dates[6]);
  await tab("看板").click();
  await expect(
    app.page.locator('.kanban-column[data-status="blocked"]'),
  ).toContainText("等待设计材料");
  results.push(
    "Lifecycle, ordering, task state, schedule and dependencies survive abrupt native restart",
  );

  const shortcut = () =>
    app.page
      .locator(".sidebar-project-list .project-card")
      .filter({ hasText: "三视图验收项目" });
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
  await (
    await projectOptions()
  )
    .getByRole("button", { name: "编辑项目", exact: true })
    .click();
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
  await expect(
    app.page.getByRole("combobox", { name: "项目筛选" }),
  ).toHaveCount(0);
  await expect(app.page.getByText("追踪项目", { exact: true })).toHaveCount(0);
  await expect(shortcut()).toBeVisible();
  const summary = await app.page.locator(".project-summary").boundingBox();
  expect(summary.y).toBeLessThan(100);
  await app.page.screenshot({
    path: join(evidence, "desktop-project-navigation.png"),
  });
  results.push(
    "Sidebar project navigation clears drafts and prevents navigation during save; tracking and filters are removed; summary shows project progress",
  );

  // Completed children remain inspectable inside expanded branches even when
  // completed root tasks are hidden. Exercise a nested branch like the UI bug.
  await tab("任务视图").click();
  const capture = app.page.getByLabel("项目任务标题", { exact: true });
  await capture.fill("完成子任务回归");
  await capture.press("Enter");
  const split = async (parent, children) => {
    const menu = await actions(parent);
    await menu.getByRole("button", { name: "拆分子任务", exact: true }).click();
    await menu.getByLabel("子任务（每行一条）").fill(children);
    await menu.getByRole("button", { name: "保存子任务", exact: true }).click();
    await expect(row(children.split("\n")[0])).toBeVisible();
  };
  await split("完成子任务回归", "中间子任务");
  await split("中间子任务", "完成叶子任务");
  await row("完成叶子任务")
    .getByRole("button", { name: "标为完成", exact: true })
    .click();
  await expect(row("中间子任务").locator(".task-meta")).toHaveText("1 / 1");
  await expect(
    row("完成叶子任务").getByRole("button", { name: "撤销完成", exact: true }),
  ).toBeVisible();
  await row("中间子任务")
    .getByRole("button", { name: "收起子任务：中间子任务", exact: true })
    .click();
  await expect(row("完成叶子任务")).toHaveCount(0);
  await row("中间子任务")
    .getByRole("button", { name: "展开子任务：中间子任务", exact: true })
    .click();
  await row("完成叶子任务")
    .getByRole("button", { name: "撤销完成", exact: true })
    .click();
  await expect(row("中间子任务").locator(".task-meta")).toHaveText("0 / 1");
  results.push(
    "Completed nested subtasks stay visible, fold with their parent and support undoing completion",
  );
  await checkProjectRowDrag(app, evidence);
  results.push(
    "Whole-row sorting, cross-parent drag, subtree movement and compact Gantt editor",
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
