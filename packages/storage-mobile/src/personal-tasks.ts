import {
  calendarDate,
  validatePersonalTime,
  type TimeValue,
  type WorkSnapshot,
} from "@praxis/application";
import type { WorkspaceSnapshot } from "./workspace";
type Data = Record<string, unknown>;
const object = (value: unknown): Data =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Data)
    : {};
const text = (value: unknown): string | null =>
  typeof value === "string" && value !== "" ? value : null;
const number = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
function typed(value: unknown): TimeValue | null {
  const parsed: unknown = typeof value === "string" ? JSON.parse(value) : value;
  if (parsed == null) return null;
  const t = parsed as TimeValue;
  validatePersonalTime(t);
  return t;
}
function time(
  data: Data,
  field: string,
  nativeField: string,
  zone: string,
): TimeValue | null {
  const desktop = object(data.desktop);
  let original = typed(desktop[nativeField]);
  if (!original && nativeField === "deadline_value" && text(desktop.deadline))
    original = typed({
      kind: "instant",
      atUtc: desktop.deadline,
      displayTimezone: desktop.deadline_time_zone ?? zone,
    });
  const day = text(data[field]);
  // An unchanged compatibility date must not erase the exact original instant.
  if (
    original &&
    (day === null ||
      day ===
        (original.kind === "date"
          ? original.date
          : calendarDate(new Date(original.atUtc), original.displayTimezone)))
  )
    return original;
  return day ? typed({ kind: "date", date: day }) : null;
}
/** Preserve extension fields; only an explicitly changed date replaces its typed value. */
export function mobilePersonalTaskFields(base: Data, patch: Data): Data {
  const next = { ...base, ...patch };
  const desktop = { ...object(base.desktop), ...object(patch.desktop) };
  for (const [field, native] of [
    ["startDate", "plan_value"],
    ["dueDate", "deadline_value"],
    ["followUpDate", "follow_up_value"],
  ] as const) {
    if (
      Object.hasOwn(patch, field) &&
      (patch[field] ?? null) !== (base[field] ?? null)
    ) {
      const value = text(patch[field]);
      const replacement = value ? { kind: "date" as const, date: value } : null;
      validatePersonalTime(replacement);
      desktop[native] = replacement ? JSON.stringify(replacement) : null;
      if (field === "dueDate") {
        desktop.deadline = null;
        desktop.deadline_time_zone = null;
      }
    }
  }
  if (Object.keys(desktop).length) next.desktop = desktop;
  if (next.status === "waiting") {
    next.status = "todo";
    next.waiting = true;
  } else if (
    Object.hasOwn(patch, "status") &&
    (patch.status !== base.status ||
      ["completed", "cancelled"].includes(String(patch.status)))
  )
    next.waiting = false;
  return next;
}
/** Read projection only. The source entities remain available to versioned commands. */
export function mobilePersonalWork(
  snapshot: WorkspaceSnapshot,
  fallbackZone: string,
): WorkSnapshot {
  const live = snapshot.entities.filter((e) => !e.deleted);
  const settings = live
    .filter((e) => e.kind === "settings")
    .map((e) => ({
      timeZone: String(e.data.timeZone ?? fallbackZone),
      version: e.version,
    }));
  const zone = settings[0]?.timeZone ?? fallbackZone;
  calendarDate(new Date(0), zone);
  const depRows = new Map<string, Set<string>>();
  for (const e of live) {
    if (e.kind !== "desktop_row" || e.data.table !== "task_dependencies")
      continue;
    const row = object(e.data.row);
    const taskId = text(row.task_id),
      predId = text(row.predecessor_id);
    if (!taskId || !predId) continue;
    const set = depRows.get(taskId) ?? new Set<string>();
    set.add(predId);
    depRows.set(taskId, set);
  }
  const tasks = live
    .filter((e) => e.kind === "task")
    .map((e) => {
      const d = e.data,
        desktop = object(d.desktop),
        raw = String(d.status ?? desktop.status ?? "todo");
      const deps = new Set<string>(depRows.get(e.id));
      if (Array.isArray(d.dependencies))
        for (const v of d.dependencies)
          if (typeof v === "string" && v) deps.add(v);
      return {
        id: e.id,
        title: String(d.title ?? ""),
        notes: String(d.notes ?? ""),
        completionCriteria: String(
          d.completionCriteria ?? desktop.completion_criteria ?? "",
        ),
        projectId: text(d.projectId),
        parentId: text(d.parentId),
        sectionId: text(d.sectionId),
        status: raw,
        rawStatus: raw,
        waiting: d.waiting === true || raw === "waiting",
        statusReason: String(d.statusReason ?? desktop.status_reason ?? ""),
        version: e.version,
        plan: time(d, "startDate", "plan_value", zone),
        deadline: time(d, "dueDate", "deadline_value", zone),
        followUp: time(d, "followUpDate", "follow_up_value", zone),
        priority: number(d.priority) || 4,
        important: number(desktop.important),
        waitingFor: String(d.waitingFor ?? desktop.waiting_for ?? ""),
        waitingNote: String(d.waitingReason ?? desktop.waiting_note ?? ""),
        completedAt: Object.hasOwn(d, "completedAt")
          ? text(d.completedAt)
          : text(desktop.completed_at),
        createdAt: e.createdAt,
        rank: number(d.rank ?? desktop.task_rank),
        labels: Array.isArray(d.tags)
          ? d.tags.filter((v): v is string => typeof v === "string")
          : [],
        ...(deps.size ? { dependencies: [...deps] } : {}),
      };
    });
  return {
    settings: settings.length ? settings : [{ timeZone: zone, version: 0 }],
    tasks,
    projects: live
      .filter((e) => e.kind === "project")
      .map((e) => ({
        id: e.id,
        name: String(e.data.title ?? ""),
        outcome: String(e.data.outcome ?? ""),
        targetDate: text(e.data.dueDate),
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        status:
          e.data.status === "active" &&
          ["draft", "paused"].includes(String(object(e.data.desktop).status))
            ? String(object(e.data.desktop).status)
            : String(e.data.status ?? "active"),
        version: e.version,
        planVersion: number(e.data.planVersion),
        focused: Number(e.data.focused === true),
        archivedAt: text(e.data.archivedAt),
      })),
    sections: live
      .filter((e) => e.kind === "section")
      .map((e) => ({
        id: e.id,
        projectId: String(e.data.projectId),
        name: String(e.data.title ?? ""),
        rank: number(e.data.rank),
        version: e.version,
      })),
    labels: [],
    days: [],
    legacyPlans: live
      .filter((e) => e.kind === "task" && text(e.data.executionDate))
      .map((e) => ({
        taskId: e.id,
        date: String(e.data.executionDate),
        focus: 0,
        rank: 0,
      })),
    events: [],
    migrationReport: "",
  };
}
