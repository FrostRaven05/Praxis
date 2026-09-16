import { expect, test } from "vitest";
import { calendarDate } from "./calendar-date";

test("today follows the user's time zone when UTC is still the previous day", () => {
  expect(calendarDate(new Date("2026-09-15T16:05:00Z"), "Asia/Hong_Kong")).toBe(
    "2026-09-16",
  );
});

test.each([
  ["2026-09-15T15:59:59Z", "Asia/Hong_Kong", "2026-09-15"],
  ["2026-09-15T16:00:00Z", "Asia/Hong_Kong", "2026-09-16"],
  ["2026-09-16T01:00:00Z", "America/Los_Angeles", "2026-09-15"],
  ["2026-03-08T09:59:59Z", "America/Los_Angeles", "2026-03-08"],
  ["2026-03-08T10:00:00Z", "America/Los_Angeles", "2026-03-08"],
])("calendar day for %s in %s is %s", (instant, zone, expected) => {
  expect(calendarDate(new Date(instant), zone)).toBe(expected);
});
test("invalid zones and instants are rejected instead of producing a made-up date", () => {
  expect(() => calendarDate(new Date(), "Not/AZone")).toThrow();
  expect(() => calendarDate(new Date("invalid"), "Asia/Hong_Kong")).toThrow();
});
