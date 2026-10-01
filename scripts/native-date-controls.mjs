import { expect } from "@playwright/test";

export async function viewDate(page) {
  const trigger = page.getByRole("button", {
    name: "查看日期",
    exact: true,
  });
  const date = await trigger.getAttribute("aria-description");
  expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  return date;
}

export async function chooseCalendarDate(picker, date) {
  const year = Number(date.slice(0, 4)),
    month = Number(date.slice(5, 7));
  if (
    (await picker.getByRole("button", { name: date, exact: true }).count()) ===
    0
  ) {
    await picker.getByRole("button", { name: "选择月份", exact: true }).click();
    let displayedYear = Number(
      (
        await picker.locator(".calendar-heading h3").getAttribute("aria-label")
      ).match(/\d+/)[0],
    );
    while (displayedYear !== year) {
      const delta = displayedYear < year ? 1 : -1;
      await picker
        .getByRole("button", {
          name: delta > 0 ? "下一年" : "上一年",
          exact: true,
        })
        .click();
      displayedYear += delta;
      await expect(
        picker.getByRole("heading", {
          name: `${displayedYear}年`,
          exact: true,
        }),
      ).toBeVisible();
    }
    await picker
      .getByRole("button", { name: `${year}年${month}月`, exact: true })
      .click();
  }
  await picker.getByRole("button", { name: date, exact: true }).click();
}

export async function chooseDate(page, label, value) {
  const trigger = page.getByRole("button", { name: label, exact: true });
  if (!value) {
    await page
      .getByRole("button", { name: "清除" + label, exact: true })
      .click();
    await expect(trigger).not.toHaveAttribute("aria-description");
    return;
  }
  await trigger.click();
  const picker = page.getByRole("dialog", {
    name: label + "选择器",
    exact: true,
  });
  await expect(picker).toBeVisible();
  if (value.includes("T")) {
    await picker
      .getByLabel(label + "小时", { exact: true })
      .fill(value.slice(11, 13));
    await picker
      .getByLabel(label + "分钟", { exact: true })
      .fill(value.slice(14, 16));
  }
  await chooseCalendarDate(picker, value.slice(0, 10));
  await expect(picker).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-description", value);
  await expect(trigger).toBeFocused();
}

export async function chooseViewDate(page, date) {
  const trigger = page.getByRole("button", {
    name: "查看日期",
    exact: true,
  });
  await trigger.click();
  const picker = page.getByRole("dialog", {
    name: "查看日期选择器",
    exact: true,
  });
  await expect(picker).toBeVisible();
  await chooseCalendarDate(picker, date);
  await expect(picker).toHaveCount(0);
  await expect(trigger).toHaveAttribute("aria-description", date);
  await expect(trigger).toBeFocused();
}
