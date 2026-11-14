import { expect } from "@playwright/test";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
export async function runProjectScenario(page, mode, evidence, checks) {
  const check = (text) => checks.push(`${mode}: ${text}`);
  await expect(
    page.getByRole("region", { name: "个人待办", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const f = window.__todoFixture,
      projects = f.current().projects,
      tasks = f.current().tasks;
    const p = (name, patch = {}) => ({
      ...structuredClone(projects[0]),
      id: crypto.randomUUID(),
      name,
      outcome: "",
      targetDate: null,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-04T00:00:00Z",
      ...patch,
    });
    const empty = p("空项目", { targetDate: "2000-01-01" }),
      tree = p("旧树形项目"),
      done = p("全完成项目"),
      archived = p("旧归档项目", { archivedAt: "2026-11-05T00:00:00Z" });
    projects.push(empty, tree, done, archived);
    const t = (title, pid, patch = {}) => ({
      ...structuredClone(tasks[0]),
      id: crypto.randomUUID(),
      title,
      projectId: pid,
      plan: null,
      deadline: null,
      ...patch,
    });
    const parent = t("父任务", tree.id);
    tasks.push(
      parent,
      t("完成叶子", tree.id, {
        parentId: parent.id,
        status: "completed",
        rawStatus: "completed",
      }),
      t("逾期叶子", tree.id, {
        parentId: parent.id,
        deadline: { kind: "date", date: "2000-01-01" },
      }),
      t("取消叶子", tree.id, {
        parentId: parent.id,
        status: "cancelled",
        rawStatus: "cancelled",
      }),
      t("全完成任务", done.id, { status: "completed", rawStatus: "completed" }),
    );
    window.dispatchEvent(new Event("praxis-lan-sync"));
  });
  if (mode === "desktop") await page.locator(".project-list-link").click();
  else {
    await page.getByRole("navigation", { name: "主导航", exact: true })
      .getByRole("button", { name: "项目", exact: true }).click();
  }
  const list = page.getByRole("region", { name: "个人项目列表", exact: true });
  const card = (name) =>
    list.locator(".personal-project-card").filter({
      has: page.getByRole("button", { name: new RegExp(`^${name}`) }),
    });
  await expect(list).toBeVisible();
  await expect(list.locator(".personal-project-card")).toHaveCount(5);
  await expect(card("旧树形项目")).toContainText("1 / 2 已完成 · 50%");
  await expect(card("旧树形项目")).toContainText("逾期 1");
  await expect(card("旧树形项目")).toContainText("有效叶子");
  await expect(card("空项目")).toContainText("还没有任务");
  await expect(card("空项目")).toContainText("逾期 0");
  await expect(card("全完成项目")).toContainText("1 / 1 已完成 · 100%");
  await list.getByRole("checkbox", { name: "显示已归档项目" }).check();
  await expect(card("旧归档项目")).toBeVisible();
  check(
    "shared project list uses leaf progress, empty/all-complete states, typed deadlines; old archived projects remain reachable",
  );
  for (const theme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
    await page.screenshot({
      path: join(evidence, `${mode}-projects-${theme}.png`),
      fullPage: true,
    });
  }
  const layout = await page.evaluate(() => ({
    viewport: innerWidth,
    body: document.documentElement.scrollWidth,
    formFields: null,
  }));
  expect(layout.body).toBeLessThanOrEqual(layout.viewport);
  await writeFile(
    join(evidence, `${mode}-layout.json`),
    JSON.stringify(layout, null, 2),
  );
  check(
    "project cards fit the viewport in light/dark themes with reduced motion",
  );
  await list.getByRole("button", { name: "新建项目", exact: true }).click();
  const form = page.getByRole("form", { name: "项目基本信息" });
  await expect(form).toBeVisible();
  expect(await form.locator("input,textarea").count()).toBe(3);
  await form.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(form).toBeVisible();
  await form.getByLabel("项目名称", { exact: true }).fill("仅名称项目");
  await page.screenshot({
    path: join(evidence, `${mode}-short-form.png`),
    fullPage: true,
  });
  await form.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "仅名称项目", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("项目任务进度", { exact: true })).toContainText(
    "还没有任务",
  );
  const created = await page.evaluate(() =>
    window.__todoFixture
      .current()
      .projects.find((p) => p.name === "仅名称项目"),
  );
  expect(created).toMatchObject({
    outcome: "",
    targetDate: null,
    status: "active",
  });
  check(
    "only name is required; exactly three form fields; success opens the new project detail and empty progress",
  );
  await page.getByRole("button", { name: "全部项目", exact: true }).click();
  await card("个人项目甲")
    .getByRole("button", { name: "编辑基本信息", exact: true })
    .click();
  await form.getByLabel("项目名称", { exact: true }).fill("个人项目甲更名");
  await form
    .getByLabel("目标（可选）", { exact: true })
    .fill("保留原项目并更新目标");
  await form.getByLabel("目标日期（可选）", { exact: true }).fill("2026-12-10");
  await form.getByRole("button", { name: "保存项目", exact: true }).click();
  await expect(form).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "个人项目甲更名", exact: true }),
  ).toBeVisible();
  const edited = await page.evaluate(() =>
    window.__todoFixture
      .current()
      .projects.find((p) => p.id === window.__todoFixture.projectA),
  );
  expect(edited).toMatchObject({
    name: "个人项目甲更名",
    outcome: "保留原项目并更新目标",
    targetDate: "2026-12-10",
    status: "active",
    priority: 2,
  });
  if (mode === "mobile")
    expect(edited.data).toMatchObject({
      recoveryNote: "原有恢复卡",
      desktop: { priority: 2, opaque: "保留" },
    });
  await page.getByRole("button", { name: "全部项目", exact: true }).click();
  await expect(list.locator(".personal-project-card").first()).toContainText(
    "个人项目甲更名",
  );
  if (mode === "mobile") {
    await card("个人项目甲更名")
      .getByRole("button", { name: "编辑与恢复卡", exact: true })
      .click();
    await expect(page.locator(".pm-dialog")).toBeVisible();
    await page
      .locator(".pm-dialog")
      .getByRole("button", { name: "取消", exact: true })
      .click();
  } else {
    await card("个人项目甲更名")
      .getByRole("button", { name: /^个人项目甲更名/ })
      .click();
    await page.getByText("更多项目设置", { exact: true }).click();
    await page
      .getByRole("button", { name: "管理状态、归档与分区", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "项目与分区", exact: true }),
    ).toBeVisible();
    await page.getByText("项目状态与归档", { exact: true }).click();
    await expect(
      page.getByRole("combobox", { name: "项目生命周期", exact: true }),
    ).toHaveValue("active");
    await page.locator(".project-list-link").click();
  }
  check(
    "basic edits retain identity, old priority/lifecycle/recovery extensions and move the project to the top; compatibility editor remains reachable",
  );
  await list.getByRole("button", { name: "新建项目", exact: true }).click();
  await form.getByLabel("项目名称", { exact: true }).fill("回包丢失项目");
  const start = await page.evaluate(() => {
    const f = window.__todoFixture;
    f.writeFault = "unknown";
    return f.commands.length;
  });
  await form.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(
    form.getByRole("button", { name: "重试保存", exact: true }),
  ).toBeVisible();
  await expect(form.getByLabel("项目名称", { exact: true })).toBeDisabled();
  await expect(
    form.getByRole("button", { name: "取消", exact: true }),
  ).toBeDisabled();
  await form.getByRole("button", { name: "重试保存", exact: true }).click();
  await expect(form).toHaveCount(0);
  const retry = await page.evaluate((start) => {
    const f = window.__todoFixture;
    return {
      commands: f.commands.slice(start),
      count: f.current().projects.filter((p) => p.name === "回包丢失项目")
        .length,
    };
  }, start);
  expect(retry.commands).toHaveLength(2);
  expect(retry.commands[0]).toEqual(retry.commands[1]);
  expect(retry.count).toBe(1);
  check(
    "unknown save result locks the draft and retries the exact project/operation/version/time without duplicates",
  );
  await page.getByRole("button", { name: "全部项目", exact: true }).click();
  await list.getByRole("button", { name: "新建项目", exact: true }).click();
  await form.getByLabel("项目名称", { exact: true }).fill("拒绝后保留输入");
  await page.evaluate(() => (window.__todoFixture.writeFault = "rejected"));
  await form.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByLabel("项目名称", { exact: true })).toHaveValue(
    "拒绝后保留输入",
  );
  await expect(form.getByLabel("项目名称", { exact: true })).toBeEnabled();
  expect(
    await page.evaluate(
      () =>
        window.__todoFixture
          .current()
          .projects.filter((p) => p.name === "拒绝后保留输入").length,
    ),
  ).toBe(0);
  await form.getByRole("button", { name: "取消", exact: true }).click();
  check(
    "definite rejection preserves editable input, permits cancel and creates no project",
  );
  await list.getByRole("button", { name: "新建项目", exact: true }).click();
  await form.getByLabel("项目名称", { exact: true }).fill("已保存仅读取失败");
  await page.evaluate(() => (window.__todoFixture.readAfterWriteFault = true));
  await form.getByRole("button", { name: "创建项目", exact: true }).click();
  await expect(
    form.getByRole("button", { name: "重试打开项目", exact: true }),
  ).toBeVisible();
  const n = await page.evaluate(() => {
    window.__todoFixture.readFault = false;
    return window.__todoFixture.commands.length;
  });
  await form.getByRole("button", { name: "重试打开项目", exact: true }).click();
  await expect(form).toHaveCount(0);
  expect(await page.evaluate(() => window.__todoFixture.commands.length)).toBe(
    n,
  );
  await expect(
    page.getByRole("heading", { name: "已保存仅读取失败", exact: true }),
  ).toBeVisible();
  check(
    "committed save plus failed refresh retries only the read and opens the same project",
  );
  await page.getByRole("button", { name: "全部项目", exact: true }).click();
  await page.evaluate(() => {
    const f = window.__todoFixture;
    f.current().tasks.find((t) => t.title === "完成叶子").status = "todo";
    f.current().tasks.find((t) => t.title === "完成叶子").rawStatus = "todo";
    window.dispatchEvent(new Event("praxis-lan-sync"));
  });
  if (mode === "mobile")
    await page.evaluate(() =>
      document.dispatchEvent(new Event("visibilitychange")),
    );
  await expect(card("旧树形项目")).toContainText("0 / 2 已完成 · 0%");
  check("refresh after a reopen updates the same legacy leaf progress");
}
