import { expect } from "@playwright/test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

export async function runRemainingScenario(page, mode, evidence, checks) {
  const check = (text) => checks.push(`${mode}: ${text}`),
    title = "恢复闭环任务";
  const home = page.getByRole("region", { name: "个人待办", exact: true });
  const mainNav = page.getByRole("navigation", { name: "主导航", exact: true });
  const projectOverview = mode === "desktop"
    ? page.getByRole("button", { name: "项目总览", exact: true })
    : mainNav.getByRole("button", { name: "项目", exact: true });
  const row = (name) =>
    home
      .locator(".personal-todo-row")
      .filter({ has: page.getByRole("button", { name, exact: true }) });
  const growth = home.getByRole("region", { name: "个人成长", exact: true });
  const done = home.locator("details > summary").filter({ hasText: /^已完成/ });
  const deleted = home
    .locator("details > summary")
    .filter({ hasText: /^已删除任务/ });
  const undo = home.getByRole("button", { name: "撤销上次操作", exact: true });
  const refresh = home.getByRole("button", { name: "刷新待办", exact: true });
  const capture = home.getByRole("textbox", {
    name: "新任务标题",
    exact: true,
  });
  async function openSummary(summary) {
    if ((await summary.locator("..").getAttribute("open")) === null)
      await summary.click();
  }
  async function returnHome() {
    await mainNav
      .getByRole("button", {
        name: mode === "mobile" ? "待办" : "我的待办",
        exact: true,
      })
      .click();
    await expect(home).toBeVisible();
    await expect(capture).toBeEnabled();
  }
  const storedTask = () =>
    page.evaluate(
      (title) =>
        structuredClone(
          window.__todoFixture.current().tasks.find((t) => t.title === title),
        ),
      title,
    );
  await expect(capture).toBeEnabled();
  await expect(mainNav.getByRole("button")).toHaveCount(2);
  await expect(growth).toContainText("总计 10 XP · 今天完成 0 项");
  check(
    "two primary destinations and the default all-personal-task home are active; unknown historical completion contributes XP but not today",
  );
  await page.evaluate(() => {
    const f = window.__todoFixture,
      template = f
        .current()
        .tasks.find((t) => t.title === "没有日期的独立任务"),
      parent = crypto.randomUUID();
    f.current().tasks.push(
      {
        ...structuredClone(template),
        id: parent,
        title: "旧树形父任务",
        projectId: f.projectA,
      },
      {
        ...structuredClone(template),
        id: crypto.randomUUID(),
        title: "旧树形子任务",
        projectId: f.projectA,
        parentId: parent,
      },
    );
    window.dispatchEvent(new Event("praxis-lan-sync"));
  });
  await expect(
    row("旧树形父任务").getByRole("button", {
      name: "删除：旧树形父任务",
      exact: true,
    }),
  ).toBeDisabled();
  await expect(
    row("旧树形子任务").getByRole("button", {
      name: "删除：旧树形子任务",
      exact: true,
    }),
  ).toBeDisabled();
  check(
    "legacy parent and child deletion stays behind the original relationship-preview interface, without silently turning it into a flat deletion",
  );

  await growth.getByText("成长显示设置", { exact: true }).click();
  await growth
    .getByRole("checkbox", { name: "减少成长动效", exact: true })
    .check();
  await growth.getByRole("button", { name: "隐藏成长", exact: true }).click();
  await expect(
    growth.getByRole("button", { name: "显示成长", exact: true }),
  ).toBeVisible();
  await capture.fill(title);
  await capture.press("Enter");
  await expect(capture).toHaveValue("");
  await expect(row(title)).toBeVisible();
  await growth.getByRole("button", { name: "显示成长", exact: true }).click();
  await growth.getByText("成长显示设置", { exact: true }).click();
  await expect(
    growth.getByRole("checkbox", { name: "减少成长动效", exact: true }),
  ).toBeChecked();
  check(
    "hiding growth and reducing motion keep inline task creation usable; the restore-growth control recovers the same scope's preference",
  );

  const original = (await storedTask()).id;
  const status = () =>
    row(title).getByRole("combobox", {
      name: `任务状态：${title}`,
      exact: true,
    });
  await status().selectOption("completed");
  await expect(growth).toContainText("总计 20 XP · 今天完成 1 项");
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(status()).toHaveValue("todo");
  await expect(growth).toContainText("总计 10 XP · 今天完成 0 项");
  expect((await storedTask()).completedAt).toBeNull();
  expect((await storedTask()).id).toBe(original);
  await status().selectOption("in_progress");
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(status()).toHaveValue("todo");
  check(
    "completion and in-progress changes can be undone within ten seconds; XP and original completion facts return without duplicating the task",
  );

  await status().selectOption("completed");
  await expect(undo).toBeVisible();
  await page.clock.fastForward(11000);
  await expect(undo).toHaveCount(0);
  await openSummary(done);
  await expect(status()).toHaveValue("completed");
  await status().selectOption("todo");
  await expect(status()).toHaveValue("todo");
  check(
    "the ten-second undo prompt expires, while completed history remains available for an explicit reopen",
  );

  await status().selectOption("in_progress");
  await expect(undo).toBeVisible();
  await page.evaluate((title) => {
    const f = window.__todoFixture,
      t = f.current().tasks.find((t) => t.title === title);
    t.version++;
    t.notes = "另一设备的新说明";
    window.dispatchEvent(new Event("praxis-lan-sync"));
  }, title);
  await undo.click();
  await expect(home.getByRole("alert")).toContainText(
    /任务已(?:发生变化|变更)/,
  );
  expect(await storedTask()).toMatchObject({
    status: "in_progress",
    notes: "另一设备的新说明",
  });
  if (
    await home
      .getByRole("button", { name: "重新读取", exact: true })
      .isVisible()
  )
    await home.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(status()).toBeEnabled();
  check(
    "an intervening edit invalidates the frozen undo basis instead of overwriting the newer notes or status",
  );

  const start = await page.evaluate(() => {
    const f = window.__todoFixture;
    f.writeFault = "unknown";
    return { commands: f.commands.length, applies: f.applies };
  });
  await status().selectOption("completed");
  await expect(
    home.getByRole("button", { name: "重试原操作", exact: true }),
  ).toBeVisible();
  if (mode === "desktop")
    await expect(
      projectOverview,
    ).toBeDisabled();
  else {
    await projectOverview.click();
    await expect(home).toBeVisible();
  }
  await home.getByRole("button", { name: "重试原操作", exact: true }).click();
  await expect(growth).toContainText("总计 20 XP");
  const replay = await page.evaluate((start) => {
    const f = window.__todoFixture;
    return {
      commands: f.commands.slice(start.commands),
      applies: f.applies - start.applies,
    };
  }, start);
  expect(replay.commands).toHaveLength(2);
  expect(replay.commands[0]).toEqual(replay.commands[1]);
  expect(replay.applies).toBe(1);
  check(
    "a lost completion response freezes navigation and replays the exact original receipt only once",
  );

  await openSummary(done);
  const completedAt = (await storedTask()).completedAt;
  const deleteStart = await page.evaluate(() => {
    const f = window.__todoFixture;
    f.writeFault = "unknown";
    return { commands: f.commands.length, applies: f.applies };
  });
  await row(title)
    .getByRole("button", { name: `删除：${title}`, exact: true })
    .click();
  await expect(
    home.getByRole("button", { name: "重试原操作", exact: true }),
  ).toBeVisible();
  await home.getByRole("button", { name: "重试原操作", exact: true }).click();
  await expect(growth).toContainText("总计 10 XP");
  await expect(row(title)).toHaveCount(0);
  const deletion = await page.evaluate((start) => {
    const f = window.__todoFixture;
    return {
      commands: f.commands.slice(start.commands),
      applies: f.applies - start.applies,
    };
  }, deleteStart);
  expect(deletion.commands).toHaveLength(2);
  expect(deletion.commands[0]).toEqual(deletion.commands[1]);
  expect(deletion.applies).toBe(1);
  await expect(undo).toBeVisible();
  await undo.click();
  await expect(growth).toContainText("总计 20 XP");
  await openSummary(done);
  await expect(status()).toHaveValue("completed");
  expect(await storedTask()).toMatchObject({
    id: original,
    deleted: false,
    completedAt,
  });
  check(
    "soft-delete withdraws XP, unknown delete retries once, and undo restores the same completed task and its original completion date",
  );

  await row(title)
    .getByRole("button", { name: `删除：${title}`, exact: true })
    .click();
  await expect(growth).toContainText("总计 10 XP");
  await page.clock.fastForward(11000);
  await expect(undo).toHaveCount(0);
  await openSummary(deleted);
  const restore = home.getByRole("button", {
    name: `恢复：${title}`,
    exact: true,
  });
  await expect(restore).toBeEnabled();
  await page.evaluate(
    (title) => window.__todoFixture.editVersion(title),
    title,
  );
  await restore.click();
  await expect(home.getByRole("alert")).toContainText(
    /任务已(?:发生变化|变更)/,
  );
  expect((await storedTask()).deleted).toBe(true);
  if (
    await home
      .getByRole("button", { name: "重新读取", exact: true })
      .isVisible()
  )
    await home.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(restore).toBeEnabled();
  const restoreStart = await page.evaluate(() => {
    const f = window.__todoFixture;
    f.writeFault = "unknown";
    return { commands: f.commands.length, applies: f.applies };
  });
  await restore.click();
  await expect(
    home.getByRole("button", { name: "重试原操作", exact: true }),
  ).toBeVisible();
  await home.getByRole("button", { name: "重试原操作", exact: true }).click();
  const restoration = await page.evaluate((start) => {
    const f = window.__todoFixture;
    return {
      commands: f.commands.slice(start.commands),
      applies: f.applies - start.applies,
    };
  }, restoreStart);
  expect(restoration.commands).toHaveLength(2);
  expect(restoration.commands[0]).toEqual(restoration.commands[1]);
  expect(restoration.applies).toBe(1);
  await expect(growth).toContainText("总计 20 XP");
  await openSummary(done);
  await expect(status()).toHaveValue("completed");
  expect((await storedTask()).id).toBe(original);
  check(
    "after the undo prompt expires, deleted tasks remain recoverable; stale versions reject and unknown restoration replays its original receipt once",
  );

  await home.getByRole("button", { name: "下一步建议", exact: true }).click();
  let agent = page.getByRole("dialog", { name: "行动助手", exact: true });
  await expect(agent).toBeVisible();
  await expect(
    agent.getByText(
      "AI 当前未启用或不可连接。系统事实可查看，手动任务管理仍可继续。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    agent.getByRole("button", { name: "请 AI 解释下一步", exact: true }),
  ).toBeDisabled();
  await expect(
    agent
      .getByRole("region", { name: "系统下一步建议", exact: true })
      .locator("li"),
  ).toHaveCount(3);
  const beforeAI = await page.evaluate(
    () => window.__todoFixture.commands.length,
  );
  await agent
    .getByRole("button", { name: "关闭行动助手", exact: true })
    .click();
  expect(await page.evaluate(() => window.__todoFixture.commands.length)).toBe(
    beforeAI,
  );
  check(
    "the unconfigured AI panel still exposes sourced read-only facts and up to three system suggestions; closing it makes no task changes",
  );

  await projectOverview.click();
  const projects = page.getByRole("region", {
    name: "个人项目列表",
    exact: true,
  });
  await expect(projects).toBeVisible();
  await projects.getByRole("button", { name: "新建项目", exact: true }).click();
  const projectForm = page.getByRole("form", {
    name: "项目基本信息",
    exact: true,
  });
  await projectForm
    .getByLabel("项目名称", { exact: true })
    .fill("三页面验收项目");
  await projectForm
    .getByRole("button", { name: "创建项目", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "三页面验收项目", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("项目任务进度", { exact: true })).toContainText(
    "还没有任务",
  );
  const board = page.getByRole("region", { name: "项目任务", exact: true }),
    projectInput = board.getByRole("textbox", {
      name: "项目任务标题",
      exact: true,
    });
  await expect(projectInput).toBeEnabled();
  await projectInput.fill("项目统计叶子");
  await projectInput.press("Enter");
  await expect(projectInput).toHaveValue("");
  const projectRow = () =>
    board.locator(".personal-todo-row").filter({
      has: page.getByRole("button", { name: "项目统计叶子", exact: true }),
    });
  await projectRow().getByRole("combobox").selectOption("completed");
  await expect(page.getByLabel("项目任务进度", { exact: true })).toContainText(
    "1 / 1 已完成 · 100%",
  );
  await openSummary(
    board.locator("details > summary").filter({ hasText: /^已完成/ }),
  );
  await projectRow().getByRole("combobox").selectOption("todo");
  await expect(page.getByLabel("项目任务进度", { exact: true })).toContainText(
    "0 / 1 已完成 · 0%",
  );
  expect(
    await page.evaluate(
      () =>
        window.__todoFixture
          .current()
          .projects.find((p) => p.name === "三页面验收项目").status,
    ),
  ).toBe("active");
  check(
    "project list, empty detail and task list form the three core pages; all-complete/reopen progress updates without automatically ending the project",
  );

  await page.getByRole("button", { name: "✦ 拆成步骤", exact: true }).click();
  agent = page.getByRole("dialog", { name: "行动助手", exact: true });
  await expect(agent).toBeVisible();
  await expect(
    agent.getByRole("button", { name: "生成任务草稿", exact: true }),
  ).toBeDisabled();
  await agent
    .getByRole("button", { name: "关闭行动助手", exact: true })
    .click();
  await expect(projectInput).toBeEnabled();
  if (mode === "desktop") {
    await page.getByRole("tab", { name: "层级与排序", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "层级与排序", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await page.getByRole("tab", { name: "任务视图", exact: true }).click();
    await projectRow()
      .getByRole("button", { name: "项目统计叶子", exact: true })
      .click();
    await expect(
      page.getByRole("complementary", { name: "项目任务详情", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "关闭任务详情", exact: true })
      .click();
  } else {
    await page.getByText("原层级任务与录入", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "＋ 添加项目任务", exact: true }),
    ).toBeVisible();
    await projectRow()
      .getByRole("button", { name: "项目统计叶子", exact: true })
      .click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
  }
  check(
    "unconfigured project decomposition does not block manual entry; original hierarchy and task-detail compatibility interfaces remain reachable",
  );
  await returnHome();
  if (mode === "desktop") {
    await page.getByText("更多个人功能", { exact: true }).click();
    await page
      .getByRole("navigation", { name: "兼容功能", exact: true })
      .getByRole("link", { name: "今日与近期", exact: true })
      .click();
    await expect(home).toHaveCount(0);
  } else {
    await page.getByRole("button", { name: "打开菜单", exact: true }).click();
    await page.getByRole("button", { name: "日历", exact: true }).click();
    await expect(home).toHaveCount(0);
  }
  await returnHome();
  check(
    "previous daily/calendar functions remain in secondary navigation and can return to the personal home",
  );

  await page.setViewportSize({
    width: mode === "mobile" ? 320 : 1280,
    height: mode === "mobile" ? 740 : 900,
  });
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.screenshot({
      path: join(evidence, `${mode}-remaining-${theme}.png`),
      fullPage: mode !== "mobile",
    });
  }
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.documentElement.scrollWidth,
    animations: [...document.querySelectorAll(".personal-growth-strip *")].map(
      (el) => getComputedStyle(el).animationName,
    ),
  }));
  expect(layout.body).toBeLessThanOrEqual(layout.viewport);
  expect(layout.animations.every((v) => v === "none")).toBe(true);
  await writeFile(
    join(evidence, `${mode}-layout.json`),
    JSON.stringify(layout, null, 2),
  );
  check(
    "small-screen/dark/reduced-motion layouts do not overflow and growth animation stays disabled",
  );
}
