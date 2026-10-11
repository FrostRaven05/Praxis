import type { Connection } from "./index";
import { calendarDate } from "@praxis/application";

function parseWorkspaceImport(json: string) {
  if (json.length > 20_000_000) reject("导入文件过大。");
  let input: {
    format?: unknown;
    version?: unknown;
    workspace?: { title?: unknown };
    entities?: unknown;
    history?: unknown;
  };
  try {
    input = JSON.parse(json) as typeof input;
  } catch {
    reject("文件不是有效 JSON。");
  }
  if (
    !input ||
    typeof input !== "object" ||
    input.format !== "praxis-mobile-workspace" ||
    input.version !== 1 ||
    !Array.isArray(input.entities) ||
    input.entities.length > 10000
  )
    reject("不支持此导出格式或版本。");
  const entities = input.entities as WorkspaceEntity[];
  const seen = new Set<string>();
  for (const e of entities) {
    if (
      !e ||
      !uuid.test(e.id) ||
      seen.has(e.id) ||
      !workspaceKinds.includes(e.kind) ||
      !Number.isInteger(e.version) ||
      e.version < 1 ||
      !e.data ||
      typeof e.data !== "object" ||
      Array.isArray(e.data) ||
      typeof e.deleted !== "boolean" ||
      !Number.isFinite(Date.parse(e.createdAt)) ||
      !Number.isFinite(Date.parse(e.updatedAt))
    )
      reject("导入条目格式无效。");
    seen.add(e.id);
  }
  validateGraph(entities);
  const history = (input.history ?? []) as Record<string, unknown>[];
  if (!Array.isArray(history) || history.length > 100000)
    reject("操作历史格式无效。");
  const historyIds = new Set<string>();
  for (const h of history) {
    if (
      !h ||
      !uuid.test(String(h.operation_id)) ||
      historyIds.has(String(h.operation_id)) ||
      typeof h.payload !== "string" ||
      !Number.isFinite(Date.parse(String(h.occurred_at)))
    )
      reject("操作历史条目无效。");
    try {
      JSON.parse(h.payload);
    } catch {
      reject("操作历史内容无效。");
    }
    historyIds.add(String(h.operation_id));
  }
  return { input, entities, history };
}
export function previewWorkspaceImport(json: string): {
  count: number;
  counts: Record<string, number>;
} {
  const { entities } = parseWorkspaceImport(json);
  const counts: Record<string, number> = {};
  for (const e of entities) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  return { count: entities.length, counts };
}
export const workspaceKinds = [
  "capture",
  "task",
  "project",
  "section",
  "plan",
  "record",
  "habit",
  "habit_check",
  "recurrence",
  "review",
  "view",
  "settings",
  "strategy",
  "decision",
  "focus",
  "desktop_row",
] as const;
export type WorkspaceKind = (typeof workspaceKinds)[number];
export interface WorkspaceEntity {
  id: string;
  kind: WorkspaceKind;
  version: number;
  data: Record<string, unknown>;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface WorkspaceSnapshot {
  entities: WorkspaceEntity[];
  pendingOperations: number;
}
export interface MobileWorkspace {
  id: string;
  title: string;
  active: boolean;
}
export interface WorkspaceChange {
  id: string;
  kind: WorkspaceKind;
  expectedVersion: number | null;
  data: Record<string, unknown>;
  deleted?: boolean;
}
export interface WorkspaceCommand {
  operationId: string;
  occurredAt: string;
  changes: WorkspaceChange[];
}
export class WorkspaceRejectedError extends Error {}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function reject(message: string): never {
  throw new WorkspaceRejectedError(message);
}
function date(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const parsed = new Date(value + "T00:00:00Z");
  return (
    Number.isFinite(parsed.valueOf()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}
export async function readWorkspace(
  db: Connection,
): Promise<WorkspaceSnapshot> {
  const rows =
    (
      await db.query(
        "SELECT * FROM mobile_entities WHERE workspace_id=(SELECT id FROM mobile_workspaces WHERE active=1) ORDER BY created_at,id",
      )
    ).values ?? [];
  const entities = rows.map((row) => ({
    id: String(row.id),
    kind: row.kind as WorkspaceKind,
    version: Number(row.version),
    data: JSON.parse(String(row.data)) as Record<string, unknown>,
    deleted: !!row.deleted,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
  const pending = (
    await db.query(
      "SELECT COUNT(*) AS count FROM mobile_operations WHERE workspace_id=(SELECT id FROM mobile_workspaces WHERE active=1)",
    )
  ).values?.[0];
  return { entities, pendingOperations: Number(pending?.count ?? 0) };
}
export function validateGraph(entities: WorkspaceEntity[]) {
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
            new TextEncoder().encode(String(d[k])).length > 100000,
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
          Number(output.version) < 1 ||
          Number(output.version) > target.version
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
export async function listWorkspaces(
  db: Connection,
): Promise<MobileWorkspace[]> {
  return (
    (await db.query("SELECT * FROM mobile_workspaces ORDER BY rowid")).values ??
    []
  ).map((r) => ({
    id: String(r.id),
    title: String(r.title),
    active: !!r.active,
  }));
}
export async function switchWorkspace(
  db: Connection,
  id: string,
): Promise<WorkspaceSnapshot> {
  if (!(await listWorkspaces(db)).some((w) => w.id === id))
    reject("工作空间不存在。");
  await db.beginTransaction();
  try {
    await db.run("UPDATE mobile_workspaces SET active=0", [], false);
    await db.run(
      "UPDATE mobile_workspaces SET active=1 WHERE id=?",
      [id],
      false,
    );
    await db.commitTransaction();
    return readWorkspace(db);
  } catch (e) {
    try {
      await db.rollbackTransaction();
    } catch {}
    throw e;
  }
}
export async function exportWorkspace(db: Connection): Promise<string> {
  const snapshot = await readWorkspace(db);
  const workspace = (await listWorkspaces(db)).find((w) => w.active)!;
  const history =
    (
      await db.query(
        "SELECT operation_id,payload,occurred_at FROM mobile_operations WHERE workspace_id=? UNION SELECT operation_id,payload,occurred_at FROM mobile_import_history WHERE workspace_id=?",
        [workspace.id, workspace.id],
      )
    ).values ?? [];

  return JSON.stringify(
    {
      format: "praxis-mobile-workspace",
      version: 1,
      exportedAt: new Date().toISOString(),
      workspace,
      entities: snapshot.entities,
      history,
    },
    null,
    2,
  );
}
export async function importWorkspace(
  db: Connection,
  json: string,
  operationId: string,
): Promise<WorkspaceSnapshot> {
  if (!uuid.test(operationId) || json.length > 20_000_000)
    reject("导入内容或操作编号无效。");
  const { input, entities, history } = parseWorkspaceImport(json);
  await db.beginTransaction();
  try {
    const previous = (
      await db.query(
        "SELECT json AS payload FROM mobile_import_receipts WHERE operation_id=?",
        [operationId],
      )
    ).values?.[0];
    if (previous) {
      if (previous.payload !== json) reject("导入编号已被使用。");
      await db.run("UPDATE mobile_workspaces SET active=0", [], false);
      await db.run(
        "UPDATE mobile_workspaces SET active=1 WHERE id=?",
        [operationId],
        false,
      );
      await db.commitTransaction();
      return readWorkspace(db);
    }
    await db.run("UPDATE mobile_workspaces SET active=0", [], false);
    await db.run(
      "INSERT INTO mobile_workspaces(id,title,active) VALUES(?,?,1)",
      [
        operationId,
        String(input.workspace?.title ?? "导入工作空间").slice(0, 200) +
          "（导入）",
      ],
      false,
    );
    for (const e of entities)
      await db.run(
        "INSERT INTO mobile_entities VALUES(?,?,?,?,?,?,?,?)",
        [
          operationId,
          e.id,
          e.kind,
          e.version,
          JSON.stringify(e.data),
          e.deleted ? 1 : 0,
          e.createdAt,
          e.updatedAt,
        ],
        false,
      );
    for (const h of history)
      await db.run(
        "INSERT INTO mobile_import_history VALUES(?,?,?,?)",
        [operationId, h.operation_id, h.payload, h.occurred_at],
        false,
      );
    await db.run(
      "INSERT INTO mobile_import_receipts VALUES(?,?)",
      [operationId, json],
      false,
    );
    await db.run(
      "INSERT INTO mobile_operations VALUES(?,?,?,?)",
      [
        operationId,
        operationId,
        JSON.stringify({
          kind: "workspace_imported",
          entities: entities.length,
        }),
        new Date().toISOString(),
      ],
      false,
    );
    await db.commitTransaction();
    return readWorkspace(db);
  } catch (e) {
    try {
      await db.rollbackTransaction();
    } catch {}
    throw e;
  }
}
export async function changeWorkspace(
  db: Connection,
  command: WorkspaceCommand,
): Promise<WorkspaceSnapshot> {
  if (
    !uuid.test(command.operationId) ||
    !Number.isFinite(Date.parse(command.occurredAt)) ||
    !Array.isArray(command.changes) ||
    !command.changes.length ||
    command.changes.length > 10000
  )
    reject("操作数据无效。");
  const payload = JSON.stringify(command);
  if (payload.length > 10_000_000) reject("单次内容过大，请分批保存。");
  await db.beginTransaction();
  try {
    const replay = (
      await db.query(
        "SELECT payload,workspace_id FROM mobile_operations WHERE operation_id=?",
        [command.operationId],
      )
    ).values?.[0];
    if (replay) {
      if (
        replay.payload !== payload ||
        replay.workspace_id !==
          (await listWorkspaces(db)).find((w) => w.active)?.id
      )
        reject("操作编号已用于其他内容或工作空间。");
      await db.commitTransaction();
      return readWorkspace(db);
    }
    const snapshot = await readWorkspace(db);
    const entities = new Map(snapshot.entities.map((e) => [e.id, e]));
    // Undo is validated against the current transactional graph, not merely output
    // versions: adding a child/reference does not increment its target's version.
    const references = (value: unknown, id: string): boolean =>
      value === id ||
      (Array.isArray(value)
        ? value.some((v) => references(v, id))
        : value !== null && typeof value === "object"
          ? Object.values(value).some((v) => references(v, id))
          : false);
    for (const c of command.changes) {
      const original = entities.get(c.id);
      if (
        c.kind !== "capture" ||
        original?.data.status !== "clarified" ||
        c.data.status !== "inbox" ||
        !Array.isArray(original.data.outputs)
      )
        continue;
      const removed = new Set(
        command.changes
          .filter((change) => change.deleted === true)
          .map((change) => change.id),
      );
      for (const output of original.data.outputs as Record<string, unknown>[]) {
        const id = String(output.id);
        if (!removed.has(id)) continue;
        const current = entities.get(id);
        if (current && current.version !== output.version)
          reject("澄清输出已被修改，请保留输出并恢复原文。");
        if (
          snapshot.entities.some(
            (dependent) =>
              !dependent.deleted &&
              dependent.id !== c.id &&
              dependent.id !== id &&
              !removed.has(dependent.id) &&
              references(dependent.data, id),
          )
        )
          reject("澄清输出已有后续关联，请保留输出并恢复原文。");
        // Explicitly deleting newly added dependents in the same undo does not
        // make the undo safe: those dependents were not part of the capture.
        const originalOutputIds = new Set(
          (original.data.outputs as Record<string, unknown>[]).map((o) =>
            String(o.id),
          ),
        );
        if (
          snapshot.entities.some(
            (dependent) =>
              !dependent.deleted &&
              dependent.id !== c.id &&
              dependent.id !== id &&
              !originalOutputIds.has(dependent.id) &&
              references(dependent.data, id),
          )
        )
          reject("澄清输出已有后续关联，请保留输出并恢复原文。");
      }
    }
    const seen = new Set<string>();
    for (const c of command.changes) {
      if (
        !uuid.test(c.id) ||
        !workspaceKinds.includes(c.kind) ||
        !c.data ||
        typeof c.data !== "object" ||
        Array.isArray(c.data) ||
        seen.has(c.id)
      )
        reject("内容格式无效或含重复条目。");
      seen.add(c.id);
      const old = entities.get(c.id);
      if (
        old
          ? old.version !== c.expectedVersion || old.kind !== c.kind
          : c.expectedVersion !== null
      )
        reject("内容已变更，请重新读取后再保存；当前输入仍保留。");
      if (
        old &&
        ["habit", "recurrence"].includes(c.kind) &&
        Array.isArray(old.data.ruleHistory)
      ) {
        const history = Array.isArray(c.data.ruleHistory)
          ? c.data.ruleHistory
          : [];
        const workspaceZone = snapshot.entities.find(
          (e) => !e.deleted && e.kind === "settings",
        )?.data.timeZone;
        for (const prior of old.data.ruleHistory as Record<string, unknown>[])
          if (
            String(prior.effectiveDate) <=
              calendarDate(
                new Date(command.occurredAt),
                String(
                  prior.timeZone ?? old.data.timeZone ?? workspaceZone ?? "UTC",
                ),
              ) &&
            !history.some(
              (next) => JSON.stringify(next) === JSON.stringify(prior),
            )
          )
            reject("已经生效的历史规则不能修改，请新增未来规则。");
      }
      entities.set(c.id, {
        id: c.id,
        kind: c.kind,
        version: (old?.version ?? 0) + 1,
        data: c.data,
        deleted: c.deleted ?? false,
        createdAt: old?.createdAt ?? command.occurredAt,
        updatedAt: command.occurredAt,
      });
    }
    const modify = (
      e: WorkspaceEntity,
      data: Record<string, unknown>,
      deleted = e.deleted,
    ) => {
      if (!seen.has(e.id)) {
        e = { ...e, version: e.version + 1, updatedAt: command.occurredAt };
        seen.add(e.id);
      }
      entities.set(e.id, { ...e, data, deleted });
    };
    // Placement is inherited from the tree root, independent of insertion order.
    const placementRoots = new Map<string, WorkspaceEntity>();
    for (const e of [...entities.values()].filter(
      (e) => !e.deleted && e.kind === "task" && e.data.parentId,
    )) {
      let parent = entities.get(String(e.data.parentId));
      const ancestors = new Set([e.id]);
      while (parent && parent.kind === "task" && !parent.deleted) {
        if (ancestors.has(parent.id))
          reject("任务父子关系不能形成循环，必须属于同一项目和分区。");
        ancestors.add(parent.id);
        const root = placementRoots.get(parent.id);
        if (root) {
          parent = root;
          break;
        }
        const next = entities.get(String(parent.data.parentId ?? ""));
        if (!next || next.kind !== "task" || next.deleted) break;
        parent = next;
      }
      if (parent && parent.kind === "task" && !parent.deleted)
        for (const id of ancestors) placementRoots.set(id, parent);
      if (
        parent &&
        parent.kind === "task" &&
        !parent.deleted &&
        ((e.data.projectId ?? null) !== (parent.data.projectId ?? null) ||
          (e.data.sectionId ?? null) !== (parent.data.sectionId ?? null))
      )
        modify(e, {
          ...e.data,
          projectId: parent.data.projectId ?? null,
          sectionId: parent.data.sectionId ?? null,
        });
    }
    // Deleting a parent keeps its dependent rows recoverable in the same transaction.
    const deletionQueue = [...entities.values()].filter(
      (e) => seen.has(e.id) && e.deleted,
    );
    for (let i = 0; i < deletionQueue.length; i++) {
      const e = deletionQueue[i]!;
      if (e.kind === "project" || e.kind === "task")
        for (const child of entities.values())
          if (
            !child.deleted &&
            (e.kind === "project"
              ? child.data.projectId === e.id
              : child.data.parentId === e.id)
          ) {
            modify(child, { ...child.data, deletedWith: e.id }, true);
            deletionQueue.push(entities.get(child.id)!);
          }
      if (e.kind === "habit")
        for (const child of entities.values())
          if (
            !child.deleted &&
            child.kind === "habit_check" &&
            child.data.habitId === e.id
          )
            modify(child, { ...child.data, deletedWith: e.id }, true);
      if (e.kind === "section")
        for (const task of entities.values())
          if (task.kind === "task" && task.data.sectionId === e.id)
            modify(task, { ...task.data, sectionId: null });
    }
    const restorationQueue = [...entities.values()].filter(
      (e) => seen.has(e.id) && !e.deleted,
    );
    for (let i = 0; i < restorationQueue.length; i++) {
      const e = restorationQueue[i]!;
      for (const child of entities.values())
        if (child.deleted && child.data.deletedWith === e.id) {
          const data = { ...child.data };
          delete data.deletedWith;
          modify(child, data, false);
          restorationQueue.push(entities.get(child.id)!);
        }
    }
    for (const e of [...entities.values()].filter(
      (e) => seen.has(e.id) && !e.deleted,
    )) {
      if (e.kind === "task") {
        if (
          e.data.status === "completed" &&
          [...entities.values()].some(
            (c) =>
              !c.deleted &&
              c.kind === "task" &&
              c.data.parentId === e.id &&
              !["completed", "cancelled"].includes(String(c.data.status)),
          )
        )
          reject("请先完成或取消全部子任务，再完成父任务。");
        if (e.data.status === "completed" && !e.data.completedAt)
          modify(e, { ...e.data, completedAt: command.occurredAt });
        else if (e.data.status !== "completed" && e.data.completedAt)
          modify(e, { ...e.data, completedAt: null });
      }
      if (
        e.kind === "project" &&
        e.data.status === "completed" &&
        [...entities.values()].some(
          (t) =>
            !t.deleted &&
            t.kind === "task" &&
            t.data.projectId === e.id &&
            !["completed", "cancelled"].includes(String(t.data.status)),
        )
      )
        reject("请先完成或取消项目中的任务。");
    }
    for (const p of entities.values())
      if (p.kind === "project" && p.data.nextActionId) {
        const explicit = command.changes.find((c) => c.id === p.id);
        const previous = snapshot.entities.find((e) => e.id === p.id);
        if (
          explicit &&
          explicit.data.nextActionId !== previous?.data.nextActionId
        )
          continue;
        const t = entities.get(String(p.data.nextActionId));
        if (
          !t ||
          t.deleted ||
          ["completed", "cancelled", "blocked"].includes(
            String(t.data.status),
          ) ||
          t.data.waiting === true ||
          t.data.projectId !== p.id
        )
          modify(p, { ...p.data, nextActionId: null });
      }
    for (const c of command.changes)
      if (
        c.kind === "task" &&
        c.expectedVersion === null &&
        c.data.recurrenceId
      ) {
        const rule = entities.get(String(c.data.recurrenceId));
        if (rule) {
          const original = String(c.data.originalDate);
          const history = Array.isArray(rule.data.ruleHistory)
            ? (rule.data.ruleHistory as Record<string, unknown>[])
            : [];
          const effective = history
            .filter((r) => String(r.effectiveDate) <= original)
            .at(-1) ?? { ...rule.data, effectiveDate: rule.data.startDate };
          if (
            !date(original) ||
            !date(effective.effectiveDate) ||
            original < String(effective.effectiveDate) ||
            effective.paused === true ||
            effective.active === false
          )
            reject("该日期不在重复规则的有效范围内。");
          if (
            effective.frequency === "weekdays" &&
            (!Array.isArray(effective.weekdays) ||
              !effective.weekdays.includes(
                new Date(original + "T12:00:00Z").getUTCDay(),
              ))
          )
            reject("该日期不符合重复规则的星期。");
          if (
            effective.frequency === "interval" &&
            Math.round(
              (Date.parse(original) -
                Date.parse(String(effective.effectiveDate))) /
                86400000,
            ) %
              Number(effective.interval ?? 1) !==
              0
          )
            reject("该日期不符合重复间隔。");
        }
      }
    validateGraph([...entities.values()]);
    for (const id of seen) {
      const e = entities.get(id)!;
      await db.run(
        "INSERT INTO mobile_entities(workspace_id,id,kind,version,data,deleted,created_at,updated_at) VALUES((SELECT id FROM mobile_workspaces WHERE active=1),?,?,?,?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET version=excluded.version,data=excluded.data,deleted=excluded.deleted,updated_at=excluded.updated_at",
        [
          e.id,
          e.kind,
          e.version,
          JSON.stringify(e.data),
          e.deleted ? 1 : 0,
          e.createdAt,
          e.updatedAt,
        ],
        false,
      );
    }
    await db.run(
      "INSERT INTO mobile_operations(workspace_id,operation_id,payload,occurred_at) VALUES((SELECT id FROM mobile_workspaces WHERE active=1),?,?,?)",
      [command.operationId, payload, command.occurredAt],
      false,
    );
    await db.commitTransaction();
    return readWorkspace(db);
  } catch (error) {
    try {
      await db.rollbackTransaction();
    } catch {
      /* Keep original uncertain-commit error for idempotent retry. */
    }
    throw error;
  }
}
