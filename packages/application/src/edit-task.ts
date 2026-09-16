import { RetriableCommands } from "./retriable-commands";
import type { DailyTask } from "./capture-today";
export interface EditTaskCommand {
  operationId: string;
  taskId: string;
  planId: string;
  expectedVersion: number;
  title: string;
  executionDate: string;
  timeZone: string;
  occurredAt: string;
  undoOf: string | null;
}
export interface EditStorage {
  editTask(command: EditTaskCommand): Promise<DailyTask>;
}
export interface EditReceipt {
  before: DailyTask;
  after: DailyTask;
  operationId: string;
}
export function validCalendarDate(date: string): boolean {
  const value = new Date(date + "T12:00:00Z");
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(value.getTime()) &&
    value.toISOString().slice(0, 10) === date
  );
}
export class EditTask {
  private commands = new RetriableCommands<EditTaskCommand>();
  constructor(private readonly storage: EditStorage) {}
  async save(
    task: DailyTask,
    title: string,
    date: string,
    timeZone: string,
    undoOf: string | null = null,
  ): Promise<EditReceipt> {
    const normalized = title.trim();
    if (!normalized) throw new Error("请填写任务标题");
    if (!validCalendarDate(date)) throw new Error("请选择有效的安排日期");
    if (task.status === "completed" && date !== task.executionDate)
      throw new Error("已完成任务不能改期，请先撤销完成");

    const { command, result } = await this.commands.execute(
      task.taskId,
      (command) =>
        command.title === normalized &&
        command.executionDate === date &&
        command.expectedVersion === (task.version ?? 0) &&
        command.undoOf === undoOf &&
        command.planId === task.planId,
      () => ({
        operationId: crypto.randomUUID(),
        taskId: task.taskId,
        planId: task.planId,
        expectedVersion: task.version ?? 0,
        title: normalized,
        executionDate: date,
        timeZone,
        occurredAt: new Date().toISOString(),
        undoOf,
      }),
      (command) => this.storage.editTask(command),
    );
    return { before: task, after: result, operationId: command.operationId };
  }

  undo(receipt: EditReceipt, timeZone: string): Promise<EditReceipt> {
    return this.save(
      receipt.after,
      receipt.before.title,
      receipt.before.executionDate,
      timeZone,
      receipt.operationId,
    );
  }
}
