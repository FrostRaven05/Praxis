import type { Entity } from "./entities.js";
import { StoreError } from "./store.js";
function reject(_message: string): never {
  throw new StoreError("INVALID_GRAPH");
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const d = new Date(value + "T00:00:00Z");
  return Number.isFinite(d.valueOf()) && d.toISOString().slice(0, 10) === value;
}
export function validateGraph(entities: Entity[]) {
  if (entities.filter((e) => e.kind === "settings" && !e.deleted).length > 1)
    reject("工作空间只能有一份有效设置。");
  const byId = new Map(entities.map((e) => [e.id, e]));
  // Follow each ancestor chain iteratively; valid existing trees have no depth limit.
  const checkedTasks = new Set<string>();
  for (const task of entities) {
    if (task.deleted || task.kind !== "task" || checkedTasks.has(task.id))
      continue;
    const chain = new Set<string>();
    let current = task;
    while (!checkedTasks.has(current.id)) {
      if (chain.has(current.id))
        reject("任务父子关系不能形成循环，必须属于同一项目和分区。");
      chain.add(current.id);
      const parent = byId.get(String(current.data.parentId ?? ""));
      if (!parent || parent.deleted || parent.kind !== "task") break;
      current = parent;
    }
    for (const id of chain) checkedTasks.add(id);
  }
  for (const e of entities.filter((e) => !e.deleted)) {
    const d = e.data;
    if (
      (e.kind === "review" && d.periodStart != null) ||
      (["record", "review"].includes(e.kind) &&
        [
          "periodStart",
          "periodEnd",
          "achievements",
          "blockers",
          "stopPause",
          "nextFocus",
        ].every((k) => typeof d[k] === "string"))
    ) {
      if (
        !date(d.periodStart) ||
        !date(d.periodEnd) ||
        String(d.periodStart) > String(d.periodEnd) ||
        ["achievements", "blockers", "stopPause", "nextFocus"].some(
          (k) =>
            typeof d[k] !== "string" ||
            Buffer.byteLength(String(d[k])) > 100000,
        )
      )
        reject("回顾期间或内容无效。");
    }
    if (
      e.kind === "capture" &&
      (typeof d.rawText !== "string" ||
        !d.rawText.trim() ||
        Array.from(d.rawText).length > 100000)
    )
      reject("原文不能为空，且最多 100,000 字。");
    if (e.kind === "capture" && d.outputs != null) {
      if (!Array.isArray(d.outputs)) reject("澄清输出格式无效。");
      for (const output of d.outputs as Record<string, unknown>[]) {
        const target = byId.get(String(output.id));
        if (
          !target ||
          !["task", "record"].includes(String(output.kind)) ||
          target.kind !== output.kind ||
          target.data.sourceCaptureId !== e.id ||
          !Number.isInteger(output.version) ||
          Number(output.version) < 1
        )
          reject("澄清输出引用无效。");
      }
    }
    if (
      [
        "task",
        "project",
        "section",
        "habit",
        "strategy",
        "decision",
        "view",
        "recurrence",
      ].includes(e.kind) &&
      (typeof d.title !== "string" || !d.title.trim() || d.title.length > 10000)
    )
      reject("标题不能为空，且最多 10,000 字。");
    for (const key of [
      "executionDate",
      "startDate",
      "dueDate",
      "followUpDate",
      "reviewDate",
      "originalDate",
      "date",
    ])
      if (d[key] != null && d[key] !== "" && !date(d[key]))
        reject("日期格式无效。");
    for (const key of [
      "waitingFor",
      "waitingReason",
      "notes",
      "completionCriteria",
      "blocker",
      "recoveryNote",
    ])
      if (
        d[key] != null &&
        (typeof d[key] !== "string" || String(d[key]).length > 100000)
      )
        reject("说明内容无效或过长。");
    if (e.kind === "task") {
      if (
        d.estimatedMinutes != null &&
        (!Number.isInteger(d.estimatedMinutes) ||
          Number(d.estimatedMinutes) < 1 ||
          Number(d.estimatedMinutes) > 1440)
      )
        reject("估时必须在 1 至 1440 分钟之间。");
      if (
        !["todo", "in_progress", "blocked", "completed", "cancelled"].includes(
          String(d.status),
        )
      )
        reject("任务状态无效。");
      if (
        d.priority != null &&
        (!Number.isInteger(d.priority) ||
          Number(d.priority) < 0 ||
          Number(d.priority) > 3)
      )
        reject("优先级无效。");
      if (
        d.tags != null &&
        (!Array.isArray(d.tags) ||
          d.tags.some((t) => typeof t !== "string" || !t.trim()))
      )
        reject("标签无效。");
      for (const [key, kind] of [
        ["projectId", "project"],
        ["sectionId", "section"],
        ["parentId", "task"],
      ] as const) {
        if (!d[key]) continue;
        const ref = byId.get(String(d[key]));
        if (!ref || ref.kind !== kind || ref.deleted)
          reject("关联内容不存在或已在回收站。");
        if (
          key === "parentId" &&
          (ref.id === e.id ||
            (ref.data.projectId ?? null) !== (d.projectId ?? null) ||
            (ref.data.sectionId ?? null) !== (d.sectionId ?? null))
        )
          reject("子任务必须与父任务属于同一项目和分区。");
        if (key === "sectionId" && ref.data.projectId !== d.projectId)
          reject("分区不属于该项目。");
      }
    }
    if (e.kind === "project") {
      if (!["active", "completed", "cancelled"].includes(String(d.status)))
        reject("项目状态无效。");
      if (
        d.archivedAt != null &&
        (!["completed", "cancelled"].includes(String(d.status)) ||
          typeof d.archivedAt !== "string" ||
          !Number.isFinite(Date.parse(d.archivedAt)))
      )
        reject("仅已完成或已取消项目可以归档。");
      if (d.nextActionId) {
        const task = byId.get(String(d.nextActionId));
        if (
          !task ||
          task.deleted ||
          task.kind !== "task" ||
          task.data.projectId !== e.id ||
          ["completed", "cancelled", "blocked"].includes(
            String(task.data.status),
          ) ||
          task.data.waiting === true
        )
          reject("下一步必须引用本项目的有效未完成任务。");
      }
    }
    if (e.kind === "section") {
      const p = byId.get(String(d.projectId));
      if (!p || p.kind !== "project" || p.deleted) reject("分区需要有效项目。");
    }
    if (e.kind === "habit_check") {
      const h = byId.get(String(d.habitId));
      if (!h || h.kind !== "habit" || h.deleted || !date(d.date))
        reject("习惯打卡需要有效习惯和日期。");
    }
    if (e.kind === "habit" || e.kind === "recurrence") {
      if (
        e.kind === "habit" &&
        d.target != null &&
        (!Number.isInteger(d.target) ||
          Number(d.target) < 1 ||
          Number(d.target) > 7)
      )
        reject("习惯目标必须在 1 至 7 之间。");
      if (d.ruleHistory != null) {
        if (!Array.isArray(d.ruleHistory) || d.ruleHistory.length > 1000)
          reject("历史规则格式无效。");
        let previous = "";
        for (const rule of d.ruleHistory as Record<string, unknown>[]) {
          if (
            !rule ||
            !date(rule.effectiveDate) ||
            String(rule.effectiveDate) <= previous
          )
            reject("历史规则生效日期必须递增且不能重复。");
          previous = String(rule.effectiveDate);
          if (
            !["daily", "weekly", "weekdays", "interval"].includes(
              String(rule.frequency),
            )
          )
            reject("历史规则频率无效。");
          if (
            rule.target != null &&
            (!Number.isInteger(rule.target) ||
              Number(rule.target) < 1 ||
              Number(rule.target) > 7)
          )
            reject("习惯目标无效。");
          if (
            rule.interval != null &&
            (!Number.isInteger(rule.interval) ||
              Number(rule.interval) < 1 ||
              Number(rule.interval) > 3650)
          )
            reject("历史规则间隔无效。");
          if (
            rule.weekdays != null &&
            (!Array.isArray(rule.weekdays) ||
              rule.weekdays.some(
                (v) => !Number.isInteger(v) || Number(v) < 0 || Number(v) > 6,
              ))
          )
            reject("历史规则星期无效。");
          if (rule.timeZone != null)
            try {
              new Intl.DateTimeFormat("en", {
                timeZone: String(rule.timeZone),
              });
            } catch {
              reject("规则时区无效。");
            }
        }
      }
      if (
        d.frequency != null &&
        !["daily", "weekly", "weekdays", "interval"].includes(
          String(d.frequency),
        )
      )
        reject("重复频率无效。");
      if (
        d.interval != null &&
        (!Number.isInteger(d.interval) ||
          Number(d.interval) < 1 ||
          Number(d.interval) > 3650)
      )
        reject("重复间隔无效。");
      if (
        d.weekdays != null &&
        (!Array.isArray(d.weekdays) ||
          d.weekdays.some(
            (v) => !Number.isInteger(v) || Number(v) < 0 || Number(v) > 6,
          ))
      )
        reject("星期设置无效。");
    }
    if (e.kind === "task" && d.recurrenceId) {
      const rule = byId.get(String(d.recurrenceId));
      if (!rule || rule.kind !== "recurrence" || !date(d.originalDate))
        reject("重复实例缺少有效规则和原始日期。");
    }
    if (e.kind === "plan") {
      if (!date(d.date) || !Array.isArray(d.taskIds))
        reject("每日安排需要日期和任务列表。");
      for (const id of d.taskIds as unknown[]) {
        const t = byId.get(String(id));
        if (!t || t.kind !== "task") reject("安排引用的任务不存在。");
      }
    }
    if (e.kind === "settings" && d.timeZone != null)
      try {
        new Intl.DateTimeFormat("en", { timeZone: String(d.timeZone) });
      } catch {
        reject("工作空间时区无效。");
      }
  }
  validateDesktopRows(entities);
  const checkKeys = new Set<string>();
  for (const e of entities.filter(
    (e) =>
      !e.deleted &&
      ["task", "project"].includes(e.kind) &&
      ["completed", "cancelled"].includes(String(e.data.status)),
  )) {
    if (
      entities.some(
        (child) =>
          !child.deleted &&
          child.kind === "task" &&
          (e.kind === "project"
            ? child.data.projectId === e.id
            : child.data.parentId === e.id) &&
          !["completed", "cancelled"].includes(String(child.data.status)),
      )
    )
      reject(
        e.kind === "project"
          ? "请先完成或取消项目中的任务，或重新打开项目。"
          : "请先完成或取消全部子任务，或重新打开父任务。",
      );
  }
  for (const e of entities.filter(
    (e) => !e.deleted && e.kind === "habit_check",
  )) {
    const key = String(e.data.habitId) + "/" + String(e.data.date);
    if (checkKeys.has(key)) reject("同一习惯每天只能打卡一次。");
    checkKeys.add(key);
  }
  const instanceKeys = new Set<string>();
  for (const e of entities.filter(
    (e) => e.kind === "task" && e.data.recurrenceId,
  )) {
    const key = String(e.data.recurrenceId) + "/" + String(e.data.originalDate);
    if (instanceKeys.has(key)) reject("这个日期的重复任务已经生成。");
    instanceKeys.add(key);
  }
}

function validateDesktopRows(entities: Entity[]) {
  const byId = new Map(entities.map((e) => [e.id, e]));
  const rows = entities
    .filter((e) => !e.deleted && e.kind === "desktop_row")
    .map((e) => ({
      table: String(e.data.table),
      row: e.data.row as Record<string, unknown>,
    }));
  const ref = (value: unknown, kind: string) => {
    if (
      typeof value !== "string" ||
      !(
        byId.get(value)?.kind === kind ||
        (kind === "record" &&
          ["review", "strategy", "decision"].includes(
            byId.get(value)?.kind ?? "",
          ))
      )
    )
      reject("Invalid reference");
  };
  const edges = new Map<string, string[]>();
  for (const { table, row } of rows) {
    if (
      [
        "task_labels",
        "daily_plan_items",
        "execution_records",
        "project_schedules",
        "task_dependencies",
        "domain_events",
      ].includes(table)
    )
      ref(row.task_id, "task");
    if (["project_context", "project_events"].includes(table))
      ref(row.project_id, "project");
    if (["habit_schedules", "habit_entries", "habit_events"].includes(table))
      ref(row.habit_id, "habit");
    if (table === "recurrence_rules") ref(row.template_id, "recurrence");
    if (["record_links", "weekly_reviews"].includes(table))
      ref(row.record_id, "record");
    if (table === "resolutions") ref(row.capture_id, "capture");
    if (table === "record_links") ref(row.target_id, String(row.target_type));
    if (table === "project_context" && row.next_action_task_id)
      ref(row.next_action_task_id, "task");
    if (table === "project_schedules") {
      if (
        (row.start_date == null) !== (row.end_date == null) ||
        (row.start_date != null &&
          (!date(row.start_date) ||
            !date(row.end_date) ||
            String(row.start_date) > String(row.end_date)))
      )
        reject("Invalid schedule");
    }
    if (table === "task_dependencies") {
      ref(row.predecessor_id, "task");
      const a = String(row.task_id),
        b = String(row.predecessor_id);
      if (
        a === b ||
        !byId.get(a)?.data.projectId ||
        byId.get(a)?.data.projectId !== byId.get(b)?.data.projectId ||
        entities.some(
          (e) =>
            !e.deleted &&
            e.kind === "task" &&
            [a, b].includes(String(e.data.parentId)),
        )
      )
        reject("Invalid dependency");
      edges.set(a, [...(edges.get(a) ?? []), b]);
    }
    if (
      table === "task_labels" &&
      !rows.some((e) => e.table === "labels" && e.row.id === row.label_id)
    )
      reject("Invalid label");
    if (
      table === "execution_records" &&
      row.plan_id &&
      !rows.some(
        (e) =>
          e.table === "daily_plan_items" &&
          e.row.id === row.plan_id &&
          e.row.task_id === row.task_id,
      )
    )
      reject("Invalid execution plan");
    if (
      table === "habit_entries" &&
      !rows.some(
        (e) =>
          e.table === "habit_schedules" &&
          e.row.habit_id === row.habit_id &&
          e.row.version === row.schedule_version,
      )
    )
      reject("Invalid habit schedule");
  }
  const visited = new Set<string>(),
    active = new Set<string>();
  const visit = (id: string) => {
    if (active.has(id)) reject("Dependency cycle");
    if (visited.has(id)) return;
    active.add(id);
    for (const next of edges.get(id) ?? []) visit(next);
    active.delete(id);
    visited.add(id);
  };
  for (const id of edges.keys()) visit(id);
  const schedules = rows.filter((r) => r.table === "habit_schedules");
  for (let i = 0; i < schedules.length; i++)
    for (let j = i + 1; j < schedules.length; j++) {
      const a = schedules[i]!.row,
        b = schedules[j]!.row;
      if (
        a.habit_id === b.habit_id &&
        String(a.effective_from) < String(b.effective_until ?? "9999-12-31") &&
        String(b.effective_from) < String(a.effective_until ?? "9999-12-31")
      )
        reject("Overlapping habit schedules");
    }
}
