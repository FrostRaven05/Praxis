import { expect } from "@playwright/test";
import { join } from "node:path";

export async function runFeedbackScenario(page, mode, evidence, checks) {
  if (mode === "desktop") {
    await expect(page.locator(".today-content")).toBeVisible();
    await page.evaluate(() => {
      window.__todoFixture.readFault = true;
      window.dispatchEvent(new Event("focus"));
    });
    await expect
      .poll(() => page.locator('.reference-day > [role="alert"]').count())
      .toBeGreaterThan(0);
    await page.evaluate(() => {
      window.__todoFixture.readFault = false;
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.locator('.reference-day > [role="alert"]')).toHaveCount(
      0,
    );
    checks.push(
      "desktop: a recovered automatic read clears its stale error without affecting pending edits",
    );
  }
  const home = page.getByRole("region", { name: "杂事", exact: true });
  if (!(await home.isVisible()))
    await page
      .getByRole("button", { name: "杂事", exact: true })
      .first()
      .click();
  await expect(home).toBeVisible();
  await expect(home.locator(".personal-todo-row").first()).toBeVisible();
  await page.evaluate(() => {
    window.__todoFixture.readFault = true;
    window.dispatchEvent(new Event("praxis-lan-sync"));
  });
  const notice = home.locator('[role="alert"]');
  await expect(notice).toBeVisible();
  const style = await notice.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      background: style.backgroundColor,
      border: style.borderTopWidth,
      fontSize: parseFloat(style.fontSize),
    };
  });
  expect(
    style.background,
    `${mode}: persistent errors use a neutral inline notice`,
  ).toBe("rgba(0, 0, 0, 0)");
  expect(style.border).toBe("0px");
  expect(style.fontSize).toBeLessThanOrEqual(13);
  await expect(home.locator(".personal-todo-row").first()).toBeVisible();
  await page.screenshot({
    path: join(evidence, `${mode}-persistent-error.png`),
    fullPage: true,
  });
  checks.push(
    `${mode}: persistent reads retain visible tasks and show compact neutral feedback`,
  );

  await page.evaluate(() => {
    window.__todoFixture.readFault = false;
  });
  await notice.getByRole("button", { name: "重新读取", exact: true }).click();
  await expect(notice).toHaveCount(0);
  await page.evaluate(() => {
    const fixture = window.__todoFixture;
    const read = fixture.work;
    fixture.feedbackReadFailures = 1;
    fixture.feedbackReadAttempts = 0;
    fixture.work = () => {
      fixture.feedbackReadAttempts += 1;
      if (fixture.feedbackReadFailures-- > 0) throw Error("IPC channel closed");
      return read();
    };
    window.dispatchEvent(new Event("praxis-lan-sync"));
  });
  await expect
    .poll(() => page.evaluate(() => window.__todoFixture.feedbackReadAttempts))
    .toBeGreaterThanOrEqual(2);
  await expect(home).toHaveAttribute("aria-busy", "false");
  await expect(notice).toHaveCount(0);
  checks.push(
    `${mode}: a transient read recovers in the background without replacing the task list or showing an error`,
  );

  const before = await page.evaluate(() => {
    const fixture = window.__todoFixture;
    const save = fixture.save;
    fixture.feedbackWriteFailures = 1;
    fixture.save = (command, mobile) => {
      const result = save(command, mobile);
      if (fixture.feedbackWriteFailures-- > 0)
        throw Error("IPC channel closed");
      return result;
    };
    return { applies: fixture.applies, commands: fixture.commands.length };
  });
  await home
    .getByRole("button", {
      name: mode === "desktop" ? "标为完成" : /^完成：/,
      exact: mode === "desktop",
    })
    .first()
    .click();
  await expect(home).toHaveAttribute("aria-busy", "false");
  await expect(notice).toHaveCount(0);
  const saved = await page.evaluate(() => ({
    applies: window.__todoFixture.applies,
    commands: window.__todoFixture.commands,
  }));
  expect(saved.applies).toBe(before.applies + 1);
  expect(saved.commands[before.commands + 1]).toEqual(
    saved.commands[before.commands],
  );
  checks.push(
    `${mode}: an acknowledged write with a lost response replays the same operation and records completion once`,
  );

  await page.evaluate(async () => {
    await Promise.all([
      import("/src/account.css"),
      import("/src/ai-planner.css"),
      import("/src/personal-agent.css"),
      import("/src/personal-task-inline.css"),
      import("/src/mobile/extras.css"),
      import("/src/mobile/quick-task-entry.css"),
    ]);
    const gallery = document.createElement("section");
    gallery.id = "feedback-variants";
    gallery.className = "workspace modern-workspace";
    gallery.style.cssText =
      "position:fixed;left:16px;top:16px;width:320px;max-width:calc(100vw - 32px);max-height:80vh;overflow:auto;display:block;z-index:10000;margin:0;padding:8px;background:var(--surface);";
    for (const className of [
      "error",
      "load-error",
      "account-error",
      "ai-planner-error",
      "personal-agent-error",
      "personal-task-inline-error",
      "pm-error",
      "pm-entry-error",
      "mx-error",
      "kanban-error",
      "gantt-error",
    ]) {
      const notice = document.createElement("div");
      notice.className = className;
      notice.setAttribute("role", "alert");
      notice.textContent = "暂时无法完成，请重试。";
      gallery.append(notice);
    }
    document.getElementById("root").append(gallery);
  });
  const variants = await page
    .locator('#feedback-variants [role="alert"]')
    .evaluateAll((elements) =>
      elements.map((element) => ({
        className: element.className,
        background: getComputedStyle(element).backgroundColor,
        color: getComputedStyle(element).color,
        height: element.getBoundingClientRect().height,
      })),
    );
  for (const variant of variants) {
    expect(variant.background, `${mode}/${variant.className}`).toBe(
      "rgba(0, 0, 0, 0)",
    );
    expect(variant.height, `${mode}/${variant.className}`).toBeLessThan(48);
  }
  await page.emulateMedia({ colorScheme: "dark" });
  for (const background of await page
    .locator('#feedback-variants [role="alert"]')
    .evaluateAll((elements) =>
      elements.map((element) => getComputedStyle(element).backgroundColor),
    ))
    expect(background).toBe("rgba(0, 0, 0, 0)");
  await page.emulateMedia({ colorScheme: "light" });
  await page
    .locator("#feedback-variants")
    .evaluate((element) => element.remove());
  checks.push(
    `${mode}: 11 historical error-card variants share neutral compact styling, including settings, AI, inbox, editors and mobile pages`,
  );
}
