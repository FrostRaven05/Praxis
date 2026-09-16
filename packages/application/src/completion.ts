import { calendarDate } from "./calendar-date";
import type { DailyTask } from "./capture-today";
export interface CompletionCommand {
  operationId: string;
  taskId: string;
  planId: string;
  action: "complete" | "undo";
  expectedVersion: number;
  completionId: string | null;
  executionDate: string;
  timeZone: string;
  occurredAt: string;
}
export interface CompletionStorage {
  changeCompletion(command: CompletionCommand): Promise<DailyTask>;
}
export class ChangeCompletion {
  private pending = new Map<string, CompletionCommand>();
  private saving = new Set<string>();
  constructor(private readonly storage: CompletionStorage) {}
  async change(
    task: DailyTask,
    action: CompletionCommand["action"],
    timeZone: string,
  ): Promise<DailyTask> {
    if (this.saving.has(task.taskId)) throw new Error("正在保存，请稍候");

    if (
      action === "complete" &&
      (task.status !== "todo" || task.activeCompletionId)
    )
      throw new Error("只有待办任务可以完成");
    if (
      action === "undo" &&
      (task.status !== "completed" || !task.activeCompletionId)
    )
      throw new Error("没有可撤销的完成记录");
    let command = this.pending.get(task.taskId);
    if (
      !command ||
      command.action !== action ||
      command.expectedVersion !== (task.version ?? 0) ||
      command.completionId !== (task.activeCompletionId ?? null)
    ) {
      const now = new Date();
      command = {
        operationId: crypto.randomUUID(),
        taskId: task.taskId,
        planId: task.planId,
        action,
        expectedVersion: task.version ?? 0,
        completionId: task.activeCompletionId ?? null,
        executionDate: calendarDate(now, timeZone),
        timeZone,
        occurredAt: now.toISOString(),
      };
      this.pending.set(task.taskId, command);
    }
    this.saving.add(task.taskId);
    try {
      const result = await this.storage.changeCompletion(command);
      this.pending.delete(task.taskId);
      return result;
    } finally {
      this.saving.delete(task.taskId);
    }
  }
}
