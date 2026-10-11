import { calendarDate } from "@praxis/application";
import type { WorkspaceEntity } from "@praxis/storage-mobile";

export function shiftDay(date: string, offset: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + offset);
  return value.toISOString().slice(0, 10);
}

export function shiftMonth(date: string, offset: number) {
  const value = new Date(`${date}T12:00:00Z`);
  const originalDay = value.getUTCDate();
  value.setUTCDate(1);
  value.setUTCMonth(value.getUTCMonth() + offset);
  const last = new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0),
  ).getUTCDate();
  value.setUTCDate(Math.min(originalDay, last));
  return value.toISOString().slice(0, 10);
}

export function monthDays(date: string) {
  const first = `${date.slice(0, 7)}-01`;
  const offset = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7;
  const last = shiftDay(shiftMonth(first, 1), -1);
  const length = Math.ceil((offset + Number(last.slice(-2))) / 7) * 7;
  return Array.from({ length }, (_, index) => shiftDay(first, index - offset));
}

export function calendarTasks(entities: WorkspaceEntity[], date: string) {
  return entities.filter(
    (e) =>
      !e.deleted &&
      e.kind === "task" &&
      !e.data.archivedAt &&
      e.data.status !== "cancelled" &&
      (e.data.executionDate === date || e.data.dueDate === date),
  );
}

export function timestampDay(value: unknown, timeZone: string) {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? calendarDate(date, timeZone) : null;
}

export function finitePositive(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

export function dayMetrics(
  entities: WorkspaceEntity[],
  date: string,
  timeZone: string,
) {
  const tasks = entities.filter(
    (e) =>
      !e.deleted &&
      e.kind === "task" &&
      e.data.status === "completed" &&
      timestampDay(e.data.completedAt, timeZone) === date,
  );
  const sessions = entities.filter(
    (e) =>
      !e.deleted &&
      e.kind === "focus" &&
      !!e.data.endedAt &&
      timestampDay(e.data.startedAt, timeZone) === date,
  );
  return {
    tasks,
    completed: tasks.length,
    estimatedMinutes: tasks.reduce(
      (sum, e) => sum + finitePositive(e.data.estimatedMinutes),
      0,
    ),
    focusSeconds: sessions.reduce(
      (sum, e) => sum + finitePositive(e.data.durationSeconds),
      0,
    ),
    sessions: sessions.length,
  };
}

export function focusElapsed(startedAt: unknown, now: number) {
  if (typeof startedAt !== "string") return 0;
  const start = Date.parse(startedAt);
  return Number.isFinite(start)
    ? Math.max(0, Math.floor((now - start) / 1000))
    : 0;
}
