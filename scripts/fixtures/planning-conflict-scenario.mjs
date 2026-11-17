import { expect } from "@playwright/test";
import { join } from "node:path";

export async function runPlanningConflictScenario(page, evidence, checks) {
  const task = page.locator(
    '.day-period [data-plan-id="19000000-0000-4000-8000-000000000099"]',
  );
  await expect(task).toBeVisible();
  await page.evaluate(() => {
    window.__todoFixture.plan.version += 1;
  });
  await task.getByRole("button", { name: "设为重点", exact: true }).click();
  try {
    await expect(
      task.getByRole("button", { name: "取消重点", exact: true }),
    ).toBeEnabled({ timeout: 2500 });
  } catch (error) {
    console.log(
      "Planning conflict symptom:",
      await page.locator('.today-content [role="alert"]').allTextContents(),
    );
    throw error;
  }
  await expect(page.locator('.today-content .error[role="alert"]')).toHaveCount(
    0,
  );
  checks.push(
    "A stale daily task version saves the requested star automatically without the blocking red alert.",
  );

  await page.evaluate(() => {
    Object.assign(window.__todoFixture.plan, {
      version: window.__todoFixture.plan.version + 1,
      dayPeriod: "evening",
      dayRank: 6,
      estimatedMinutes: 35,
    });
  });
  await task.getByRole("button", { name: "取消重点", exact: true }).click();
  await expect(
    task.getByRole("button", { name: "设为重点", exact: true }),
  ).toBeEnabled();
  await expect(
    page.locator(
      '.day-period[data-period="evening"] [data-plan-id="19000000-0000-4000-8000-000000000099"]',
    ),
  ).toBeVisible();
  expect(
    await page.evaluate(() => window.__todoFixture.plan.estimatedMinutes),
  ).toBe(35);

  await page.evaluate(() => {
    Object.assign(window.__todoFixture.plan, {
      version: window.__todoFixture.plan.version + 1,
      isFocus: true,
      estimatedMinutes: 45,
    });
  });
  await task
    .getByRole("button", { name: "拖动排序：安排冲突回归任务", exact: true })
    .press("ArrowLeft");
  await expect(
    page.locator(
      '.day-period[data-period="afternoon"] [data-plan-id="19000000-0000-4000-8000-000000000099"]',
    ),
  ).toBeVisible();
  await expect(
    task.getByRole("button", { name: "取消重点", exact: true }),
  ).toBeEnabled();
  expect(
    await page.evaluate(() => window.__todoFixture.plan.estimatedMinutes),
  ).toBe(45);
  checks.push(
    "Star recovery preserves concurrent placement and estimates; drag recovery preserves a concurrently changed star and estimates.",
  );

  await page.evaluate(() => {
    window.__todoFixture.pauseNextDayRead = true;
    window.dispatchEvent(new Event("praxis-lan-sync"));
  });
  await expect
    .poll(() => page.evaluate(() => !!window.__todoFixture.releaseDayRead))
    .toBe(true);
  await task.getByRole("button", { name: "取消重点", exact: true }).click();
  await expect(
    task.getByRole("button", { name: "设为重点", exact: true }),
  ).toBeEnabled();
  await page.evaluate(() => window.__todoFixture.releaseDayRead());
  await page.waitForTimeout(100);
  await expect(
    task.getByRole("button", { name: "设为重点", exact: true }),
  ).toBeEnabled();
  checks.push(
    "An older sync read completing after a successful save cannot roll back the displayed star.",
  );

  const replay = await page.evaluate(() => {
    window.__todoFixture.planFault = "unknown";
    return {
      commands: window.__todoFixture.planCommands.length,
      version: window.__todoFixture.plan.version,
    };
  });
  await task.getByRole("button", { name: "设为重点", exact: true }).click();
  await expect(
    task.getByRole("button", { name: "取消重点", exact: true }),
  ).toBeEnabled();
  const replayed = await page.evaluate(() => ({
    commands: window.__todoFixture.planCommands,
    version: window.__todoFixture.plan.version,
  }));
  expect(replayed.commands[replay.commands + 1]).toEqual(
    replayed.commands[replay.commands],
  );
  expect(replayed.version).toBe(replay.version + 1);
  await expect(page.locator(".day-save-notice")).toHaveCount(0);
  checks.push(
    "A lost acknowledgement recovers automatically by replaying the exact command without a visible notice or duplicate save.",
  );

  const start = await page.evaluate(() => {
    window.__todoFixture.planFault = "offline";
    return {
      commands: window.__todoFixture.planCommands.length,
      version: window.__todoFixture.plan.version,
    };
  });
  await task.getByRole("button", { name: "取消重点", exact: true }).click();
  const notice = page.locator(".day-save-notice");
  await expect(notice).toContainText("暂未确认保存");
  await expect(page.locator('.today-content .error[role="alert"]')).toHaveCount(
    0,
  );
  const bounds = await notice.boundingBox();
  expect(bounds.height).toBeLessThan(56);
  await page.screenshot({
    path: join(evidence, "compact-save-notice.png"),
    fullPage: true,
  });
  await page.evaluate(() => {
    window.__todoFixture.planFault = null;
  });
  await notice.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    task.getByRole("button", { name: "设为重点", exact: true }),
  ).toBeEnabled();
  const after = await page.evaluate(() => ({
    commands: window.__todoFixture.planCommands,
    version: window.__todoFixture.plan.version,
  }));
  expect(after.commands[start.commands + 1]).toEqual(
    after.commands[start.commands],
  );
  expect(after.commands[start.commands + 2]).toEqual(
    after.commands[start.commands],
  );
  expect(after.version).toBe(start.version + 1);
  await expect(notice).toHaveCount(0);
  checks.push(
    "Persistent offline failures show a compact neutral notice; manual retry replays the identical command and does not save twice.",
  );

  const beforeConflicts = await page.evaluate(() => {
    window.__todoFixture.planFault = "conflict";
    return window.__todoFixture.planCommands.length;
  });
  await task.getByRole("button", { name: "设为重点", exact: true }).click();
  await expect(notice).toContainText("安排正在更新");
  expect(
    await page.evaluate(() => window.__todoFixture.planCommands.length),
  ).toBe(beforeConflicts + 3);
  await page.evaluate(() => {
    window.__todoFixture.planFault = null;
  });
  await notice.getByRole("button", { name: "重试", exact: true }).click();
  await expect(
    task.getByRole("button", { name: "取消重点", exact: true }),
  ).toBeEnabled();
  await expect(notice).toHaveCount(0);
  await page.screenshot({
    path: join(evidence, "recovered-day.png"),
    fullPage: true,
  });
  checks.push(
    "Repeated conflicts stop after three writes, preserve the intent and recover through the compact retry control.",
  );
  await page.evaluate(() => {
    window.__todoFixture.failHabitReadOnce = true;
  });
  await task.getByRole("button", { name: "取消重点", exact: true }).click();
  await expect(
    task.getByRole("button", { name: "设为重点", exact: true }),
  ).toBeEnabled();
  await expect(notice).toHaveCount(0);
  checks.push(
    "A read failure after an acknowledged save does not create a pending write or block the task controls.",
  );
}
