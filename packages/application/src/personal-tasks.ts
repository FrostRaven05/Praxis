import { calendarDate } from "./calendar-date";
import { validCalendarDate } from "./edit-task";
import { projectTree } from "./subtasks";
import {
  subtree,
  type TimeValue,
  type WorkSnapshot,
  type WorkTask,
} from "./productivity";

export const personalTaskLabels: Readonly<Record<string, string>> = {
  todo: "待办",
  in_progress: "进行中",
  completed: "已完成",
  waiting: "等待",
  blocked: "阻塞",
  cancelled: "已取消",
};
/** Terminal facts take precedence over old, stale waiting flags. No storage writes. */
export function personalTaskStatus(rawStatus: string, waiting = false) {
  const status =
    !["completed", "cancelled"].includes(rawStatus) && waiting
      ? "waiting"
      : rawStatus;
  return {
    rawStatus,
    waiting,
    status,
    label: personalTaskLabels[status] ?? `未知状态（${status}）`,
    legacy: !["todo", "in_progress", "completed"].includes(status),
  };
}
export function validatePersonalTime(value: TimeValue | null): void {
  if (value === null) return;
  if (value.kind === "date") {
    if (!validCalendarDate(value.date)) throw Error("截止日期无效");
  } else if (value.kind === "instant") {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        value.atUtc,
      ) ||
      !validCalendarDate(value.atUtc.slice(0, 10)) ||
      !Number.isFinite(Date.parse(value.atUtc))
    )
      throw Error("截止时刻无效");
    calendarDate(new Date(value.atUtc), value.displayTimezone);
  } else throw Error("日期类型无效");
}
export type PersonalDueGroup = "overdue" | "today" | "later" | "undated";
export function personalDeadlineDay(value: TimeValue | null): string | null {
  validatePersonalTime(value);
  return value === null
    ? null
    : value.kind === "date"
      ? value.date
      : calendarDate(new Date(value.atUtc), value.displayTimezone);
}
export function personalTaskProgress(
  rows: readonly Pick<WorkTask, "id" | "parentId" | "status">[],
) {
  if (new Set(rows.map((t) => t.id)).size !== rows.length)
    throw Error("个人任务身份重复");
  const mode = rows.some(
    (t) => t.parentId !== null || personalTaskStatus(t.status).legacy,
  )
    ? "legacy-tree"
    : "flat";
  for (const t of rows)
    if (!Object.hasOwn(personalTaskLabels, t.status))
      throw Error("项目包含未知任务状态，请在兼容入口检查");
  let total = rows.length,
    done = rows.filter((t) => t.status === "completed").length;
  if (mode === "legacy-tree") {
    const roots = projectTree(
      rows.map((t) => ({
        taskId: t.id,
        parentTaskId: t.parentId,
        status: t.status,
        title: t.id,
        version: 0,
        createdAt: "2000-01-01T00:00:00Z",
        executionDate: null,
        completionDate: null,
      })),
    ).filter((t) => t.depth === 0);
    total = roots.reduce((n, t) => n + t.leafTotal, 0);
    done = roots.reduce((n, t) => n + t.leafDone, 0);
  }
  return {
    mode,
    total,
    done,
    percentage: total ? Math.round((done * 100) / total) : null,
    allTasksCompleted: total > 0 && total === done,
  };
}
export function personalDeadlineGroup(
  value: TimeValue | null,
  now: Date,
  zone: string,
): PersonalDueGroup {
  validatePersonalTime(value);
  const today = calendarDate(now, zone);
  if (!value) return "undated";
  if (value.kind === "date")
    return value.date < today
      ? "overdue"
      : value.date === today
        ? "today"
        : "later";
  if (Date.parse(value.atUtc) <= now.getTime()) return "overdue";
  return calendarDate(new Date(value.atUtc), value.displayTimezone) ===
    calendarDate(now, value.displayTimezone)
    ? "today"
    : "later";
}
/** One snapshot supplies list/detail/todo/statistics; no Today/plan membership filter. */
export function personalTaskQuery(
  work: WorkSnapshot,
  now = new Date(),
  fallbackZone = "UTC",
) {
  const timeZone = work.settings[0]?.timeZone ?? fallbackZone;
  calendarDate(now, timeZone);
  const tasks = work.tasks.map((t) => ({
    ...t,
    ...personalTaskStatus(
      t.rawStatus ?? t.status,
      t.waiting ?? t.status === "waiting",
    ),
  }));
  const byId = new Map(tasks.map((t) => [t.id, t]));
  if (byId.size !== tasks.length)
    throw Error("个人任务身份重复，请检查数据来源");
  const list = (projectId?: string | null) =>
    tasks.filter((t) => projectId === undefined || t.projectId === projectId);
  const groups: Record<PersonalDueGroup, typeof tasks> = {
    overdue: [],
    today: [],
    later: [],
    undated: [],
  };
  const completed = tasks.filter((t) => t.status === "completed");
  for (const task of tasks) {
    if (["completed", "cancelled"].includes(task.status)) continue;
    groups[personalDeadlineGroup(task.deadline, now, timeZone)].push(task);
  }
  const sortDate = (t: (typeof tasks)[number]) =>
    personalDeadlineDay(t.deadline) ?? "";
  for (const group of Object.values(groups))
    group.sort(
      (a, b) =>
        sortDate(a).localeCompare(sortDate(b)) ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  const progress = (projectId: string) => {
    const rows = list(projectId);
    const summary = personalTaskProgress(rows);
    const parents = new Set(rows.map((t) => t.parentId).filter(Boolean));
    const counted =
      summary.mode === "legacy-tree"
        ? rows.filter((t) => !parents.has(t.id))
        : rows;
    return {
      ...summary,
      overdue: counted.filter(
        (t) =>
          !["completed", "cancelled"].includes(t.status) &&
          personalDeadlineGroup(t.deadline, now, timeZone) === "overdue",
      ).length,
    };
  };
  return {
    tasks,
    timeZone,
    readAt: now.toISOString(),
    list,
    task: (id: string) => byId.get(id) ?? null,
    groups,
    completed,
    progress,
  };
}

export type PersonalTaskChange =
  | {
      type: "edit";
      title?: string;
      notes?: string;
      deadline?: TimeValue | null;
    }
  | { type: "status"; status: "todo" | "in_progress" | "completed" }
  | { type: "undoStatus"; operationId: string }
  | { type: "delete" }
  | { type: "restore" }
  | { type: "move"; projectId: string | null; confirmDescendants?: boolean };
export interface PersonalTaskBase {
  scopeKey: string;
  work: WorkSnapshot;
  fallbackZone?: string;
  trash?: PersonalDeletedTask[];
}
export interface PersonalDeletedTask {
  id: string;
  title: string;
  version: number;
  batchId: string;
  projectId: string | null;
  canRestore: boolean;
}
export interface PersonalTaskReceipt {
  operationId: string;
}
export interface PersonalTaskRead extends PersonalTaskBase {
  query: ReturnType<typeof personalTaskQuery>;
}
export interface PersonalTaskDraft {
  taskId: string;
  title: string;
  notes: string;
  deadline: TimeValue | null;
  projectId: string | null;
  parentId?: string | null;
}
/** A definite rejection: the caller may discard the attempt and reload its base. */
export class PersonalTaskRejectedError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "PersonalTaskRejectedError";
  }
}
/** A receipt in another account/workspace says nothing about an earlier unknown write. */
export class PersonalTaskScopeError extends PersonalTaskRejectedError {}
/** Internal seam: adapters freeze complete native/workspace commands at prepare time. */
export interface PersonalTaskPort<Command> {
  read(): Promise<PersonalTaskBase>;
  prepareCreate?(
    base: PersonalTaskBase,
    draft: PersonalTaskDraft,
    operationId: string,
    occurredAt: string,
  ): Command;
  prepare(
    base: PersonalTaskBase,
    taskId: string,
    change: PersonalTaskChange,
    operationId: string,
    occurredAt: string,
  ): Command;
  commit(command: Command): Promise<void>;
  rejected(error: unknown): boolean;
}
export function createPersonalTasks<Command>(
  port: PersonalTaskPort<Command>,
  clock: () => Date = () => new Date(),
) {
  const pending = new Map<
    string,
    { signature: string; command: Command; operationId: string }
  >();
  const saving = new Set<string>();
  async function execute(
    key: string,
    signature: string,
    prepare: (operationId: string) => Command,
  ) {
    if (saving.has(key)) throw Error("正在保存，请稍候");
    const retained = pending.has(key);
    let entry = pending.get(key);
    if (entry && entry.signature !== signature)
      throw Error("上次保存结果尚未确认，请先重试原内容");
    if (!entry) {
      try {
        const operationId = crypto.randomUUID();
        entry = { signature, command: prepare(operationId), operationId };
      } catch (error) {
        throw new PersonalTaskRejectedError(error);
      }
      pending.set(key, entry);
    }
    saving.add(key);
    try {
      await port.commit(entry.command);
      pending.delete(key);
      return { operationId: entry.operationId };
    } catch (error) {
      if (retained && error instanceof PersonalTaskScopeError)
        throw Error(error.message);
      if (port.rejected(error) || error instanceof PersonalTaskScopeError) {
        pending.delete(key);
        throw new PersonalTaskRejectedError(error);
      }
      throw error;
    } finally {
      saving.delete(key);
    }
  }
  return {
    async read(): Promise<PersonalTaskRead> {
      const base = await port.read();
      return {
        ...base,
        query: personalTaskQuery(base.work, clock(), base.fallbackZone),
      };
    },
    async create(
      base: PersonalTaskRead,
      draft: PersonalTaskDraft,
    ): Promise<void> {
      const normalized = { ...draft, title: draft.title.trim() };
      const key = JSON.stringify([base.scopeKey, draft.taskId]);
      const signature = JSON.stringify(["create", normalized]);
      const prepare = (operationId: string) =>
        port.prepareCreate!(
          base,
          normalized,
          operationId,
          clock().toISOString(),
        );
      // A fresh read may already contain the task whose original receipt was lost.
      if (pending.has(key)) {
        await execute(key, signature, prepare);
        return;
      }
      try {
        if (!port.prepareCreate) throw Error("当前入口不支持任务创建");
        if (!draft.title.trim() || [...draft.title.trim()].length > 500)
          throw Error("任务标题需为1至500个字符");
        if (draft.notes.length > 100000) throw Error("任务说明过长");
        if (base.query.task(draft.taskId))
          throw Error("任务身份已存在，请重新读取");
        validatePersonalTime(draft.deadline);
        if (
          draft.projectId !== null &&
          !base.work.projects.some(
            (p) =>
              p.id === draft.projectId &&
              p.status === "active" &&
              !p.archivedAt,
          )
        )
          throw Error("请选择进行中的个人项目");
        if (draft.parentId) {
          const parent = base.work.tasks.find((t) => t.id === draft.parentId);
          if (!parent) throw Error("父任务已不存在，请重新读取");
          if (parent.parentId) throw Error("子任务不能再拆子任务");
          if (parent.projectId !== draft.projectId)
            throw Error("子任务必须与父任务属于同一项目");
        }
      } catch (error) {
        throw new PersonalTaskRejectedError(error);
      }
      await execute(key, signature, prepare);
    },
    async change(
      base: PersonalTaskRead,
      taskId: string,
      change: PersonalTaskChange,
    ): Promise<PersonalTaskReceipt> {
      const task = base.query.task(taskId);
      try {
        if (change.type === "restore") {
          if (!base.trash?.some((t) => t.id === taskId && t.canRestore))
            throw Error("该任务已恢复或需要在原回收站处理");
        } else if (!task) throw Error("任务已不存在，请重新读取");
        if (change.type === "edit") {
          if (
            change.title !== undefined &&
            (!change.title.trim() || change.title.length > 10000)
          )
            throw Error("请填写有效任务标题");
          if (change.notes !== undefined && change.notes.length > 100000)
            throw Error("任务说明过长");
          if (change.deadline !== undefined)
            validatePersonalTime(change.deadline);
        } else if (change.type === "status") {
          if (!["todo", "in_progress", "completed"].includes(change.status))
            throw Error("个人任务状态无效");
        } else if (change.type === "move") {
          if (
            change.projectId !== null &&
            !base.work.projects.some(
              (p) =>
                p.id === change.projectId &&
                p.status === "active" &&
                !p.archivedAt,
            )
          )
            throw Error("请选择进行中的个人项目");
          if (
            subtree(base.work.tasks, taskId).length > 1 &&
            !change.confirmDescendants
          )
            throw Error("请先确认移动全部子任务");
        } else if (
          change.type === "delete" &&
          subtree(base.work.tasks, taskId).length > 1
        ) {
          throw Error("请先处理子任务，再删除这个任务");
        }
      } catch (error) {
        throw new PersonalTaskRejectedError(error);
      }
      return execute(
        JSON.stringify([base.scopeKey, taskId]),
        JSON.stringify([
          task?.version ?? base.trash?.find((t) => t.id === taskId)?.version,
          change,
        ]),
        (operationId) =>
          port.prepare(
            base,
            taskId,
            change,
            operationId,
            clock().toISOString(),
          ),
      );
    },
  };
}
