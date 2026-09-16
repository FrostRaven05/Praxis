import { RetriableCommands } from "./retriable-commands";
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
  private commands = new RetriableCommands<CompletionCommand>();
  constructor(private readonly storage: CompletionStorage) {}
  async change(
    task: DailyTask,
    action: CompletionCommand["action"],
    timeZone: string,
  ): Promise<DailyTask> {
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

    const { result } = await this.commands.execute(
      task.taskId,
      (command) =>
        command.action === action &&
        command.expectedVersion === (task.version ?? 0) &&
        command.completionId === (task.activeCompletionId ?? null) &&
        command.planId === task.planId,
      () => {
        const now = new Date();
        return {
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
      },
      (command) => this.storage.changeCompletion(command),
    );
    return result;
  }
}
