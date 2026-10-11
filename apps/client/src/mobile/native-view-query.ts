import type { WorkspaceEntity } from "@praxis/storage-mobile";
import {
  entityTitle,
  text,
  emptyFilter,
  searchEntities,
  kindLabel,
  type SearchFilter,
} from "./extras-model";
export interface NativeViewQuery {
  text: string;
  entityType: string;
  projectId: string | null;
  status: string | null;
  includeArchived: boolean;
  groups: { field: string; op: string; value: string }[][];
  sort: string;
  groupBy: string;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const decode = (v: unknown): Record<string, unknown> => {
  if (object(v)) return v;
  if (typeof v === "string")
    try {
      const p = JSON.parse(v);
      return object(p) ? p : {};
    } catch {}
  return {};
};
const add = (date: string, n: number) => {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
export function executeNativeView(
  entities: WorkspaceEntity[],
  value: unknown,
  today: string,
) {
  const warnings: string[] = [];
  if (object(value) && object(value.mobileFilter)) {
    const raw = value.mobileFilter;
    if (
      Object.entries(emptyFilter).some(
        ([key, fallback]) =>
          raw[key] != null && typeof raw[key] !== typeof fallback,
      )
    )
      return {
        results: [] as WorkspaceEntity[],
        warnings: ["同步视图的手机筛选扩展无效，未执行筛选。"],
        group: () => "",
      };
    const filter = { ...emptyFilter, ...raw } as SearchFilter;
    const allowed: Partial<Record<keyof SearchFilter, string[]>> = {
      kind: [
        "",
        "task",
        "project",
        "record",
        "habit",
        "strategy",
        "decision",
        "review",
      ],
      status: [
        "",
        "todo",
        "in_progress",
        "waiting",
        "blocked",
        "completed",
        "cancelled",
        "active",
        "paused",
        "draft",
      ],
      mode: ["and", "or"],
      priority: ["", "0", "1", "2", "3"],
      due: ["", "overdue", "today", "week"],
      sort: ["updated", "due", "priority", "title"],
      group: ["kind", "project", "status", "none"],
      preset: ["", "unplanned", "focus", "small", "waiting", "week"],
    };
    if (
      Object.entries(allowed).some(
        ([key, values]) =>
          !values.includes(String(filter[key as keyof SearchFilter])),
      )
    )
      return {
        results: [] as WorkspaceEntity[],
        warnings: ["同步视图含暂不支持的手机筛选选项，未执行筛选。"],
        group: () => "",
      };
    const group = (e: WorkspaceEntity) =>
      filter.group === "project"
        ? entityTitle(
            entities.find((p) => !p.deleted && p.id === e.data.projectId) ?? {
              ...e,
              data: { title: "独立内容" },
            },
          )
        : filter.group === "status"
          ? text(e.data.status) || "无状态"
          : filter.group === "kind"
            ? kindLabel(e.kind)
            : "全部结果";
    return {
      results: searchEntities(entities, filter, today),
      warnings:
        filter.projectId &&
        !entities.some((e) => !e.deleted && e.id === filter.projectId)
          ? ["视图引用的项目已删除，请重新选择。"]
          : [],
      group,
    };
  }
  if (
    !object(value) ||
    typeof value.text !== "string" ||
    typeof value.includeArchived !== "boolean" ||
    !Array.isArray(value.groups) ||
    value.groups.length > 3 ||
    !["all", "task", "project", "record", "habit"].includes(
      String(value.entityType),
    ) ||
    !["title", "priority", "plan", "deadline", "followUp", "created"].includes(
      String(value.sort),
    ) ||
    !["none", "project", "status", "priority", "type"].includes(
      String(value.groupBy),
    )
  )
    return {
      results: [] as WorkspaceEntity[],
      warnings: ["同步视图的筛选结构暂不支持，未执行筛选。"],
      group: () => "",
    };
  const query = value as unknown as NativeViewQuery,
    live = entities.filter((e) => !e.deleted),
    byId = new Map(entities.map((e) => [e.id, e]));
  const rows = live
    .filter((e) => e.kind === "desktop_row")
    .map((e) => ({ table: text(e.data.table), row: decode(e.data.row) }));
  const labels = rows.filter((r) => r.table === "labels");
  const timeZone =
    text(live.find((e) => e.kind === "settings")?.data.timeZone) || "UTC";
  const date = (e: WorkspaceEntity, field: string) => {
    const [key, column] = (
      {
        plan: ["startDate", "plan_value"],
        deadline: ["dueDate", "deadline_value"],
        followUp: ["followUpDate", "follow_up_value"],
      } as Record<string, string[]>
    )[field]!;
    const raw = decode(decode(e.data.desktop)[column!]);
    const projected =
      typeof e.data[key!] === "string" && e.data[key!]
        ? text(e.data[key!])
        : null;
    if (raw.kind === "date") return projected || text(raw.date) || null;
    if (
      typeof raw.atUtc === "string" &&
      Number.isFinite(Date.parse(raw.atUtc))
    ) {
      try {
        const instant = new Date(raw.atUtc);
        const inZone = (zone: string) => {
          const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: zone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
          }).formatToParts(instant);
          const part = (k: string) => parts.find((p) => p.type === k)?.value;
          return `${part("year")}-${part("month")}-${part("day")}`;
        };
        // Native filters interpret instants in the workspace zone. The flat
        // mobile date was projected in the value's display zone; only a changed
        // date should override the preserved instant before native acknowledgement.
        if (
          projected &&
          projected !== inZone(text(raw.displayTimezone) || timeZone)
        )
          return projected;
        return inZone(timeZone);
      } catch {
        return projected;
      }
    }
    return projected;
  };
  const kind = (e: WorkspaceEntity) =>
    ["review", "strategy", "decision"].includes(e.kind) ? "record" : e.kind;
  const status = (e: WorkspaceEntity) =>
    e.kind === "task" && e.data.waiting === true
      ? "waiting"
      : e.kind === "project" && e.data.status === "active"
        ? text(decode(e.data.desktop).status) || "active"
        : e.kind === "habit"
          ? "habit"
          : kind(e) === "record"
            ? text(decode(e.data.desktop).record_type) || e.kind
            : text(e.data.status);
  const priority = (e: WorkspaceEntity) =>
    e.kind === "task" ? Number(e.data.priority) || 4 : 9;
  const project = (e: WorkspaceEntity) =>
    e.kind === "project" ? e : byId.get(text(e.data.projectId));
  const body = (e: WorkspaceEntity) =>
    [
      e.data.body,
      e.data.notes,
      e.data.outcome,
      e.data.completionCriteria,
      e.data.blocker,
      e.data.recoveryNote,
      e.data.trigger,
      e.data.normalVersion,
      e.data.minimumVersion,
    ]
      .map(text)
      .join(" ");
  const condition = (
    e: WorkspaceEntity,
    c: NativeViewQuery["groups"][number][number],
  ): boolean => {
    const d = e.data;
    if (c.field === "project") return d.projectId === c.value;
    if (c.field === "label")
      return (
        rows.some(
          (r) =>
            r.table === "task_labels" &&
            r.row.task_id === e.id &&
            r.row.label_id === c.value,
        ) ||
        labels.some(
          (l) =>
            l.row.id === c.value &&
            Array.isArray(d.tags) &&
            d.tags.includes(l.row.name),
        )
      );
    if (c.field === "status") return status(e) === c.value;
    if (c.field === "priority" || c.field === "estimate") {
      const estimate =
        d.estimatedMinutes ?? decode(d.desktop).default_estimated_minutes;
      const n =
          c.field === "priority"
            ? priority(e)
            : typeof estimate === "number"
              ? estimate
              : NaN,
        target = Number(c.value);
      return (
        Number.isFinite(n) &&
        (c.op === "lte"
          ? n <= target
          : c.op === "gte"
            ? n >= target
            : n === target)
      );
    }
    if (
      ["nextAction", "independent", "projectActive", "unblocked"].includes(
        c.field,
      )
    ) {
      const p = project(e),
        actual =
          c.field === "nextAction"
            ? p?.data.nextActionId === e.id
            : c.field === "independent"
              ? !d.projectId
              : c.field === "projectActive"
                ? !!p &&
                  !p.deleted &&
                  status(p) === "active" &&
                  !p.data.archivedAt
                : d.status !== "blocked" &&
                  !rows.some(
                    (r) =>
                      r.table === "task_dependencies" &&
                      r.row.task_id === e.id &&
                      byId.get(text(r.row.predecessor_id)) &&
                      !byId.get(text(r.row.predecessor_id))!.deleted &&
                      !["completed", "cancelled"].includes(
                        text(byId.get(text(r.row.predecessor_id))!.data.status),
                      ),
                  );
      return actual === (c.value === "true");
    }
    const day = date(e, c.field);
    const monday = add(
      today,
      -((new Date(today + "T12:00:00Z").getUTCDay() + 6) % 7),
    );
    return c.op === "empty"
      ? !day
      : c.op === "present"
        ? !!day
        : c.op === "due"
          ? !!day && day <= today
          : c.op === "thisWeek"
            ? !!day && day >= monday && day <= add(monday, 6)
            : c.op === "eq"
              ? day === c.value
              : c.op === "lte"
                ? !!day && day <= c.value
                : !!day && day >= c.value;
  };
  for (const group of query.groups) {
    if (!Array.isArray(group) || !group.length || group.length > 12) {
      warnings.push("同步视图的 AND 条件组无效，未执行筛选。");
      continue;
    }
    for (const c of group) {
      if (
        !object(c) ||
        typeof c.value !== "string" ||
        typeof c.field !== "string" ||
        typeof c.op !== "string"
      ) {
        warnings.push("同步视图的条件格式无效。");
        continue;
      }
      const ops = [
        "project",
        "label",
        "status",
        "nextAction",
        "independent",
        "projectActive",
        "unblocked",
      ].includes(c.field)
        ? ["eq"]
        : c.field === "priority"
          ? ["eq", "lte"]
          : c.field === "estimate"
            ? ["eq", "lte", "gte"]
            : ["plan", "deadline", "followUp"].includes(c.field)
              ? ["eq", "lte", "gte", "empty", "present", "due", "thisWeek"]
              : [];
      if (!ops.includes(c.op))
        warnings.push(`暂不支持筛选条件 ${c.field}/${c.op}，未执行筛选。`);
      if (c.field === "label" && !labels.some((l) => l.row.id === c.value))
        warnings.push(`标签引用已删除或不可用：${c.value}`);
      if (
        c.field === "project" &&
        (!byId.get(c.value) || byId.get(c.value)?.deleted)
      )
        warnings.push(`项目引用已删除或不可用：${c.value}`);
    }
  }
  if (
    query.projectId &&
    (!byId.get(query.projectId) || byId.get(query.projectId)?.deleted)
  )
    warnings.push(`项目引用已删除或不可用：${query.projectId}`);
  const invalid = warnings.some((w) => /不支持|无效/.test(w));
  const results = invalid
    ? []
    : live.filter((e) => {
        if (
          !["task", "project", "record", "habit"].includes(kind(e)) ||
          (query.entityType !== "all" && query.entityType !== kind(e))
        )
          return false;
        const p = project(e);
        if (e.kind === "task" && p?.deleted) return false;
        if (!query.includeArchived && (e.data.archivedAt || p?.data.archivedAt))
          return false;
        if (
          !`${entityTitle(e)} ${body(e)}`
            .toLowerCase()
            .includes(query.text.toLowerCase())
        )
          return false;
        if (query.status && status(e) !== query.status) return false;
        if (
          query.projectId &&
          e.id !== query.projectId &&
          e.data.projectId !== query.projectId &&
          !(
            kind(e) === "record" &&
            Array.isArray(e.data.links) &&
            e.data.links.some(
              (l) =>
                object(l) &&
                (l.targetType === "project"
                  ? l.targetId === query.projectId
                  : byId.get(text(l.targetId))?.data.projectId ===
                    query.projectId),
            )
          )
        )
          return false;
        return (
          !query.groups.length ||
          (e.kind === "task" &&
            query.groups.some((g) => g.every((c) => condition(e, c))))
        );
      });
  const key = (e: WorkspaceEntity) =>
    query.sort === "priority"
      ? String(priority(e))
      : ["plan", "deadline", "followUp"].includes(query.sort)
        ? date(e, query.sort) || "9999-99-99"
        : query.sort === "created"
          ? e.createdAt
          : entityTitle(e).toLowerCase();
  results.sort((a, b) =>
    key(a) < key(b)
      ? -1
      : key(a) > key(b)
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  const group = (e: WorkspaceEntity) =>
    query.groupBy === "project"
      ? project(e)
        ? entityTitle(project(e)!)
        : "独立 / 无项目"
      : query.groupBy === "status"
        ? status(e) || "无状态"
        : query.groupBy === "priority"
          ? e.kind === "task"
            ? `P${priority(e)}`
            : "无优先级"
          : query.groupBy === "type"
            ? kind(e)
            : "全部结果";
  return { results, warnings: [...new Set(warnings)], group };
}
