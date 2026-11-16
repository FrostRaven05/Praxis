const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function specificDateLabel(date: string) {
  const day = date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return "选择日期";
  const weekday = weekdays[new Date(`${day}T12:00:00`).getDay()];
  return `${Number(day.slice(5, 7))}月${Number(day.slice(-2))}日 ${weekday}`;
}

export function reminderLabel(value: string) {
  if (!value) return "添加提醒";
  return specificDateLabel(value.slice(0, 10));
}
