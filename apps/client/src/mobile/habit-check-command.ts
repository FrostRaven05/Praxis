import type { WorkspaceChange, WorkspaceEntity } from "@praxis/storage-mobile";
import { scheduleId } from "./sync-identity";
export function habitCheckCommand(
  entities: WorkspaceEntity[],
  habitId: string,
  date: string,
  status: "done" | "skipped",
  timeZone: string,
  recordedAt: string,
  ruleEffectiveDate: string,
): WorkspaceChange {
  const prior = entities.find(
    (e) =>
      e.kind === "habit_check" &&
      e.data.habitId === habitId &&
      e.data.date === date,
  );
  return {
    id: prior?.id ?? scheduleId("habit_check", habitId, date),
    kind: "habit_check",
    expectedVersion: prior?.version ?? null,
    deleted: false,
    data: {
      ...prior?.data,
      habitId,
      date,
      status,
      timeZone,
      recordedAt,
      ruleEffectiveDate,
    },
  };
}
