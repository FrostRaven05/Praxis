import { RetriableCommands } from "./retriable-commands";
import { validCalendarDate } from "./edit-task";
import { parseMinutes } from "./planning";
export interface TaskDetailFields {
  title: string;
  notes: string;
  completionCriteria: string;
  important: boolean;
  deadline: string | null;
  deadlineTimeZone: string | null;
  estimatedMinutes: number | null;
}
export interface TaskDetails extends TaskDetailFields {
  taskId: string;
  version: number;
  status: string;
  projectId: string | null;
}
export interface TaskDetailsCommand extends TaskDetailFields {
  operationId: string;
  taskId: string;
  expectedVersion: number;
  occurredAt: string;
}
export interface TaskDetailsStorage {
  read(taskId: string): Promise<TaskDetails>;
  save(command: TaskDetailsCommand): Promise<TaskDetails>;
}
export function deadlineToLocal(value: string | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (!Number.isFinite(d.getTime())) throw new Error("截止时间无效");
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    [d.getFullYear(), pad(d.getMonth() + 1), pad(d.getDate())].join("-") +
    "T" +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes())
  );
}
export function deadlineFromLocal(value: string): string | null {
  if (!value) return null;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
    !validCalendarDate(value.slice(0, 10))
  )
    throw new Error("截止时间无效");
  const d = new Date(value);
  if (
    !Number.isFinite(d.getTime()) ||
    deadlineToLocal(d.toISOString()) !== value
  )
    throw new Error("截止时间无效");
  return d.toISOString();
}
export class TaskDetailEditor {
  private commands = new RetriableCommands<TaskDetailsCommand>();
  constructor(private storage: TaskDetailsStorage) {}
  async save(
    base: TaskDetails,
    fields: TaskDetailFields,
  ): Promise<TaskDetails> {
    const normalized = { ...fields, title: fields.title.trim() };
    if ((fields.deadline === null) !== (fields.deadlineTimeZone === null))
      throw new Error("截止时间和时区需同时设置");
    if (fields.deadlineTimeZone !== null) {
      try {
        new Intl.DateTimeFormat("en", {
          timeZone: fields.deadlineTimeZone,
        }).format();
      } catch {
        throw new Error("截止时间的时区无效");
      }
    }
    if (!normalized.title) throw new Error("请填写任务标题");
    if (fields.estimatedMinutes !== null)
      parseMinutes(String(fields.estimatedMinutes));
    if (
      fields.deadline !== null &&
      (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(
        fields.deadline,
      ) ||
        !validCalendarDate(fields.deadline.slice(0, 10)) ||
        !Number.isFinite(Date.parse(fields.deadline)))
    )
      throw new Error("截止时间无效");
    const { result } = await this.commands.execute(
      base.taskId,
      (c) =>
        c.expectedVersion === base.version &&
        Object.keys(normalized).every(
          (key) =>
            c[key as keyof TaskDetailFields] ===
            normalized[key as keyof TaskDetailFields],
        ),
      () => ({
        ...normalized,
        operationId: crypto.randomUUID(),
        taskId: base.taskId,
        expectedVersion: base.version,
        occurredAt: new Date().toISOString(),
      }),
      (c) => this.storage.save(c),
    );
    return result;
  }
}
