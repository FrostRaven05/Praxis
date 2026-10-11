import type { WorkspaceEntity, WorkspaceChange } from "@praxis/storage-mobile";
export type ScheduleRule = {
  effectiveDate: string;
  frequency: string;
  target: number;
  interval: number;
  weekdays: number[];
  paused: boolean;
  active: boolean;
  timeZone: string;
};
export function ruleAt(entity: WorkspaceEntity, date: string): ScheduleRule {
  const initial = {
    effectiveDate: String(entity.data.startDate),
    frequency: String(entity.data.frequency),
    target: Number(entity.data.target || 1),
    interval: Number(entity.data.interval || 1),
    weekdays: Array.isArray(entity.data.weekdays)
      ? (entity.data.weekdays as number[])
      : [],
    paused: !!entity.data.paused,
    active: entity.data.active !== false,
    timeZone: String(entity.data.timeZone || "Asia/Hong_Kong"),
  };
  const history = Array.isArray(entity.data.ruleHistory)
    ? (entity.data.ruleHistory as ScheduleRule[])
    : [];
  return (
    history
      .filter((r) => r.effectiveDate <= date)
      .sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate))
      .at(-1) ?? initial
  );
}
export function matchesRule(rule: ScheduleRule, date: string): boolean {
  if (date < rule.effectiveDate || rule.paused || !rule.active) return false;
  const weekday = new Date(date + "T12:00:00Z").getUTCDay();
  if (rule.frequency === "weekdays") return rule.weekdays.includes(weekday);
  if (rule.frequency === "interval")
    return (
      Math.round(
        (Date.parse(date) - Date.parse(rule.effectiveDate)) / 86400000,
      ) %
        rule.interval ===
      0
    );
  return true;
}
export function preserveRuleHistory(
  entity: WorkspaceEntity,
  next: ScheduleRule,
): Record<string, unknown> {
  const history = Array.isArray(entity.data.ruleHistory)
    ? (entity.data.ruleHistory as ScheduleRule[])
    : [ruleAt(entity, String(entity.data.startDate))];
  return {
    ...entity.data,
    ruleHistory: [
      ...history.filter((r) => r.effectiveDate !== next.effectiveDate),
      next,
    ].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate)),
  };
}
export function futureRuleChanges(
  entity: WorkspaceEntity,
  next: ScheduleRule,
  entities: WorkspaceEntity[],
): { changes: WorkspaceChange[]; preserved: number } {
  let preserved = 0;
  const changes: WorkspaceChange[] = [];
  for (const task of entities.filter(
    (e) =>
      e.kind === "task" &&
      !e.deleted &&
      e.data.recurrenceId === entity.id &&
      String(e.data.originalDate) >= next.effectiveDate,
  )) {
    if (
      task.data.status === "cancelled" &&
      task.data.ruleCancelled &&
      !task.data.manualModified &&
      matchesRule(next, String(task.data.originalDate))
    ) {
      changes.push({
        id: task.id,
        kind: task.kind,
        expectedVersion: task.version,
        data: { ...task.data, status: "todo", ruleCancelled: false },
      });
      continue;
    }
    if (
      task.data.status !== "todo" ||
      task.data.manualModified ||
      task.data.executionDate !== task.data.originalDate ||
      task.data.title !== entity.data.title
    ) {
      preserved++;
      continue;
    }
    if (!matchesRule(next, String(task.data.originalDate)))
      changes.push({
        id: task.id,
        kind: task.kind,
        expectedVersion: task.version,
        data: { ...task.data, status: "cancelled", ruleCancelled: true },
      });
  }
  return { changes, preserved };
}
