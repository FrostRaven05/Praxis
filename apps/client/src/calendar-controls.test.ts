import { expect, it } from "vitest";
import {
  calendarMonthDays,
  shiftCalendarDate,
  shiftCalendarMonth,
} from "./calendar-controls";

it("clamps month and year navigation at month end, including leap years", () => {
  expect(shiftCalendarMonth("2026-01-31", 1)).toBe("2026-02-28");
  expect(shiftCalendarMonth("2024-01-31", 1)).toBe("2024-02-29");
  expect(shiftCalendarMonth("2024-02-29", 12)).toBe("2025-02-28");
  expect(shiftCalendarMonth("2026-01-31", -1)).toBe("2025-12-31");
});
it("moves calendar days across year and leap-day boundaries without a time-zone offset", () => {
  expect(shiftCalendarDate("2026-01-01", -1)).toBe("2025-12-31");
  expect(shiftCalendarDate("2024-02-28", 1)).toBe("2024-02-29");
  expect(shiftCalendarDate("2024-02-29", 1)).toBe("2024-03-01");
});
it("covers a month in complete Monday-to-Sunday weeks without duplicate days", () => {
  const february = calendarMonthDays("2021-02-14");
  expect(february).toHaveLength(28);
  expect(february[0]).toBe("2021-02-01");
  expect(february.at(-1)).toBe("2021-02-28");
  const august = calendarMonthDays("2026-08-01");
  expect(august).toHaveLength(42);
  expect(august[0]).toBe("2026-07-27");
  expect(august.at(-1)).toBe("2026-09-06");
  expect(new Set(august).size).toBe(august.length);
});
