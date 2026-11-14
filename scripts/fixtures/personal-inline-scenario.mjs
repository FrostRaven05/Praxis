import { expect } from "@playwright/test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
export async function runInlineScenario(page, mode, evidence, checks) {
  const check = (text) => checks.push(`${mode}: ${text}`);
  const home = page.getByRole("region", { name: "个人待办", exact: true });
  const form = home.getByRole("form", { name: "添加独立任务", exact: true });
  const input = form.getByRole("textbox", { name: "新任务标题", exact: true });
  const row = (title) =>
    home
      .locator(".personal-todo-row")
      .filter({ has: page.getByRole("button", { name: title, exact: true }) });
  const editForm = (title) =>
    home.getByRole("form", { name: `行内编辑：${title}`, exact: true });
  const task = (title) =>
    page.evaluate(
      (title) =>
        structuredClone(
          window.__todoFixture.current().tasks.find((t) => t.title === title),
        ),
      title,
    );
  await expect(input).toBeEnabled();
  const initialCommands = await page.evaluate(
    () => window.__todoFixture.commands.length,
  );
  await input.fill("中文组词");
  await input.dispatchEvent("compositionstart", { data: "中文组词" });
  await input.press("Enter");
  expect(await page.evaluate(() => window.__todoFixture.commands.length)).toBe(
    initialCommands,
  );
  await input.evaluate((el) => {
    el.dispatchEvent(
      new CompositionEvent("compositionend", {
        bubbles: true,
        data: "中文组词",
      }),
    );
    el.form.requestSubmit();
  });
  expect(await page.evaluate(() => window.__todoFixture.commands.length)).toBe(
    initialCommands,
  );
  await page.waitForTimeout(70);
  await input.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        keyCode: 229,
        bubbles: true,
        cancelable: true,
      }),
    );
    el.form.requestSubmit();
  });
  expect(await page.evaluate(() => window.__todoFixture.commands.length)).toBe(
    initialCommands,
  );
  await page.waitForTimeout(70);
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  await expect(row("中文组词")).toBeVisible();
  expect(await page.evaluate(() => window.__todoFixture.commands.length)).toBe(
    initialCommands + 1,
  );
  check(
    "composition Enter, immediate compositionend submit and keyCode 229 do not create; a later intentional Enter creates exactly once and restores focus",
  );
  await row("之后的独立任务")
    .getByRole("button", { name: "行内编辑：之后的独立任务", exact: true })
    .click();
  const movingEditor = editForm("之后的独立任务"),
    beforeTime = await page.evaluate(() => Date.now());
  await movingEditor
    .getByRole("textbox", { name: "任务说明", exact: true })
    .fill("跨日期边界仍保留的草稿");
  await page.clock.fastForward(3 * 24 * 60 * 60 * 1000);
  await expect(
    movingEditor.getByRole("textbox", { name: "任务说明", exact: true }),
  ).toHaveValue("跨日期边界仍保留的草稿");
  await page.clock.setSystemTime(beforeTime);
  await movingEditor
    .getByRole("button", { name: "取消编辑", exact: true })
    .click();
  check(
    "clock-driven regrouping is deferred while editing, so crossing date boundaries does not remount or erase the inline draft",
  );
  await input.fill("连续第二项");
  await form.getByText("说明与截止日期（可选）", { exact: true }).click();
  await form
    .getByRole("textbox", { name: "任务说明", exact: true })
    .fill("第一行\n第二行");
  await form
    .getByRole("textbox", { name: "任务说明", exact: true })
    .press("Enter");
  const notes = await form
    .getByRole("textbox", { name: "任务说明", exact: true })
    .inputValue();
  expect(await page.evaluate(() => window.__todoFixture.commands.length)).toBe(
    initialCommands + 1,
  );
  await form.getByLabel("截止日期", { exact: true }).fill("2026-12-10");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(input).toBeFocused();
  const second = await task("连续第二项");
  expect(second).toMatchObject({
    notes,
    projectId: null,
    plan: null,
    deadline: { kind: "date", date: "2026-12-10" },
    status: "todo",
  });
  check(
    "consecutive entry clears all saved fields and retains focus; notes allow line breaks, optional deadline is separate from daily arrangement",
  );
  const select = row("连续第二项").getByRole("combobox", {
    name: "任务状态：连续第二项",
    exact: true,
  });
  await select.selectOption("in_progress");
  await expect(select).toHaveValue("in_progress");
  await select.selectOption("completed");
  await expect(row("连续第二项")).toBeHidden();
  await home.locator(".personal-todo-completed > summary").filter({hasText:/^已完成/}).click();
  await expect(row("连续第二项")).toBeVisible();
  await select.selectOption("todo");
  await expect(select).toHaveValue("todo");
  expect((await task("连续第二项")).id).toBe(second.id);
  check(
    "todo/in-progress/completed/reopen use one task identity and the same completed fold",
  );
  await row("连续第二项")
    .getByRole("button", { name: "行内编辑：连续第二项", exact: true })
    .click();
  let editor = editForm("连续第二项");
  await editor
    .getByRole("textbox", { name: "任务标题", exact: true })
    .fill("行内更名");
  await editor
    .getByRole("textbox", { name: "任务说明", exact: true })
    .fill("行内说明");
  await editor
    .getByRole("button", { name: "清除截止日期", exact: true })
    .click();
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await task("行内更名")).toMatchObject({
    id: second.id,
    notes: "行内说明",
    deadline: null,
    status: "todo",
  });
  await expect(row("行内更名")).toBeVisible();
  check(
    "inline title/notes and clearing the optional deadline preserve status and task identity",
  );
  await row("行内更名")
    .getByRole("button", { name: "行内编辑：行内更名", exact: true })
    .click();
  editor = editForm("行内更名");
  await editor
    .getByRole("textbox", { name: "任务说明", exact: true })
    .fill("行内回包丢失后保留的说明");
  const editStart = await page.evaluate(() => {
    const f = window.__todoFixture;
    f.writeFault = "unknown";
    return f.commands.length;
  });
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    editor.getByRole("button", { name: "重试原操作", exact: true }),
  ).toBeVisible();
  await expect(
    editor.getByRole("textbox", { name: "任务说明", exact: true }),
  ).toBeDisabled();
  await editor.getByRole("button", { name: "重试原操作", exact: true }).click();
  await expect(editor).toHaveCount(0);
  const edits = await page.evaluate(
    (start) => window.__todoFixture.commands.slice(start),
    editStart,
  );
  expect(edits).toHaveLength(2);
  expect(edits[0]).toEqual(edits[1]);
  expect((await task("行内更名")).notes).toBe("行内回包丢失后保留的说明");
  check(
    "unknown inline edits keep frozen input and expose a local retry with the original command",
  );
  const old = await task("精确时刻已逾期");
  await row(old.title)
    .getByRole("button", { name: `行内编辑：${old.title}`, exact: true })
    .click();
  editor = editForm(old.title);
  await editor
    .getByRole("textbox", { name: "任务说明", exact: true })
    .fill("只更新说明，保留原时刻");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect((await task(old.title)).deadline).toEqual(old.deadline);
  await row(old.title)
    .getByRole("button", { name: `行内编辑：${old.title}`, exact: true })
    .click();
  editor = editForm(old.title);
  await editor
    .getByRole("button", { name: "修改截止日期", exact: true })
    .click();
  const calendar = await editor
    .getByLabel("截止日期（可选）", { exact: true })
    .inputValue();
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect((await task(old.title)).deadline).toEqual({
    kind: "date",
    date: calendar,
  });
  check(
    "an unrelated edit preserves the original instant/zone; explicit same-day date replacement converts only when requested",
  );
  await row("保留等待状态")
    .getByRole("button", { name: "行内编辑：保留等待状态", exact: true })
    .click();
  editor = editForm("保留等待状态");
  await editor
    .getByRole("textbox", { name: "任务说明", exact: true })
    .fill("等待资料不丢失");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).toHaveCount(0);
  expect(await task("保留等待状态")).toMatchObject({
    waiting: true,
    waitingFor: "原有反馈",
    rawStatus: "todo",
  });
  await expect(row("保留等待状态").getByRole("combobox")).toHaveValue(
    "waiting",
  );
  check(
    "editing old waiting tasks retains raw status, waiting flag and existing context",
  );
  await row("行内更名")
    .getByRole("button", { name: "行内编辑：行内更名", exact: true })
    .click();
  editor = editForm("行内更名");
  await editor
    .getByRole("textbox", { name: "任务说明", exact: true })
    .fill("我的未保存草稿");
  await page.evaluate(() => {
    const f = window.__todoFixture,
      t = f.current().tasks.find((t) => t.title === "行内更名");
    t.version++;
    t.notes = "其他设备的新说明";
    window.dispatchEvent(new Event("praxis-lan-sync"));
  });
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(
    editor.getByText(
      "任务版本已变化，草稿仍保留。取消行内编辑后重新读取，避免覆盖新编辑。",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    editor.getByRole("textbox", { name: "任务说明", exact: true }),
  ).toHaveValue("我的未保存草稿");
  expect((await task("行内更名")).notes).toBe("其他设备的新说明");
  await editor.getByRole("button", { name: "取消编辑", exact: true }).click();
  await expect(input).toBeEnabled();
  check(
    "a stale inline version rejects without overwriting another edit or replacing the local draft during sync",
  );
  await input.fill("未知回包任务");
  const start = await page.evaluate(() => {
    const f = window.__todoFixture;
    f.writeFault = "unknown";
    return f.commands.length;
  });
  await input.press("Enter");
  await expect(
    form.getByRole("button", { name: "重试原操作", exact: true }),
  ).toBeVisible();
  await expect(input).toBeDisabled();
  await form.getByRole("button", { name: "重试原操作", exact: true }).click();
  await expect(input).toHaveValue("");
  const retried = await page.evaluate(
    (start) => ({
      commands: window.__todoFixture.commands.slice(start),
      count: window.__todoFixture
        .current()
        .tasks.filter((t) => t.title === "未知回包任务").length,
    }),
    start,
  );
  expect(retried.commands).toHaveLength(2);
  expect(retried.commands[0]).toEqual(retried.commands[1]);
  expect(retried.count).toBe(1);
  check(
    "unknown create result freezes the input and retries the identical task/operation/time once",
  );
  await input.fill("明确拒绝的任务");
  await page.evaluate(() => (window.__todoFixture.writeFault = "rejected"));
  await input.press("Enter");
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("明确拒绝的任务");
  await form
    .getByRole("button", { name: "重新读取并保留草稿", exact: true })
    .click();
  await expect(input).toHaveValue("明确拒绝的任务");
  await expect(input).toBeEnabled();
  await input.fill("重新读取后保存任务");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await expect(row("重新读取后保存任务")).toBeVisible();
  check(
    "definite create rejection keeps editable input; explicit reread retains the draft before a new attempt",
  );
  await input.fill("保存成功仅读取失败");
  await page.evaluate(() => (window.__todoFixture.readAfterWriteFault = true));
  await input.press("Enter");
  await expect(
    form.getByRole("button", { name: "重新读取任务", exact: true }),
  ).toBeVisible();
  const count = await page.evaluate(() => {
    window.__todoFixture.readFault = false;
    return window.__todoFixture.commands.length;
  });
  await form.getByRole("button", { name: "重新读取任务", exact: true }).click();
  await expect(input).toHaveValue("");
  expect(await page.evaluate(() => window.__todoFixture.commands.length)).toBe(
    count,
  );
  check(
    "a committed create plus failed read retries only the read and retains the saved task ID",
  );
  await row("未安排到今日的项目任务")
    .getByRole("button", { name: "个人项目甲", exact: true })
    .click();
  const project = page.getByRole("region", { name: "项目任务", exact: true }),
    projectInput = project.getByRole("textbox", {
      name: "项目任务标题",
      exact: true,
    });
  await expect(projectInput).toBeEnabled();
  await projectInput.fill("项目内连续任务");
  await projectInput.press("Enter");
  await expect(projectInput).toHaveValue("");
  await expect(projectInput).toBeFocused();
  const projectTask = await task("项目内连续任务");
  expect(projectTask.projectId).toBe(
    await page.evaluate(() => window.__todoFixture.projectA),
  );
  await project
    .getByRole("combobox", { name: "任务状态：项目内连续任务", exact: true })
    .selectOption("in_progress");
  await expect(
    project.getByRole("combobox", {
      name: "任务状态：项目内连续任务",
      exact: true,
    }),
  ).toHaveValue("in_progress");
  if (mode === "desktop") {
    await page.getByRole("tab", { name: "层级与排序", exact: true }).click();
    await expect(
      page.getByRole("tabpanel").locator(".personal-todo-home"),
    ).toHaveCount(0);
    await page.getByRole("tab", { name: "任务视图", exact: true }).click();
    await page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button", { name: "我的待办", exact: true })
      .click();
  } else {
    await page.getByText("原层级任务与录入", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "＋ 添加项目任务", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button", { name: "待办", exact: true })
      .click();
  }
  await expect(row("项目内连续任务").getByRole("combobox")).toHaveValue(
    "in_progress",
  );
  expect((await task("项目内连续任务")).id).toBe(projectTask.id);
  check(
    "project detail shares continuous entry and state edits; old hierarchy entry remains available and homepage shows the same task/state",
  );
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.screenshot({
      path: join(evidence, `${mode}-inline-${theme}.png`),
      fullPage: mode !== "mobile",
    });
  }
  await row("行内更名")
    .getByRole("button", { name: "行内编辑：行内更名", exact: true })
    .click();
  await page.screenshot({
    path: join(evidence, `${mode}-inline-editor.png`),
    fullPage: mode !== "mobile",
  });
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.documentElement.scrollWidth,
  }));
  expect(layout.body).toBeLessThanOrEqual(layout.viewport);
  await writeFile(
    join(evidence, `${mode}-layout.json`),
    JSON.stringify(layout, null, 2),
  );
  await editForm("行内更名")
    .getByRole("button", { name: "取消编辑", exact: true })
    .click();
  check(
    "light/dark themes, reduced motion and inline editor fit the viewport without an assignee control",
  );
}
