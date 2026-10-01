function instant(date: string) {
  return new Date(date + "T12:00:00Z");
}
function day(value: Date) {
  return value.toISOString().split("T")[0]!;
}

export function shiftCalendarDate(date: string, days: number) {
  const value = instant(date);
  value.setUTCDate(value.getUTCDate() + days);
  return day(value);
}
export function shiftCalendarMonth(date: string, months: number) {
  const value = instant(date),
    originalDay = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + months);
  const end = new Date(value);
  end.setUTCMonth(end.getUTCMonth() + 1);
  end.setUTCDate(0);
  value.setUTCDate(Math.min(originalDay, end.getUTCDate()));
  return day(value);
}
export function calendarWeekday(date: string) {
  return (instant(date).getUTCDay() + 6) % 7;
}
export function calendarMonthDays(date: string) {
  const first = date.slice(0, 7) + "-01";
  const end = shiftCalendarDate(shiftCalendarMonth(first, 1), -1);
  const count =
    Math.ceil((calendarWeekday(first) + Number(end.slice(-2))) / 7) * 7;
  const start = shiftCalendarDate(first, -calendarWeekday(first));
  return Array.from({ length: count }, (_, index) =>
    shiftCalendarDate(start, index),
  );
}
