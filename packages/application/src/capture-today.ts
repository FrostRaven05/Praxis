import { calendarDate } from "./calendar-date";

export interface CaptureCommand {
  operationId: string;
  taskId: string;
  planId: string;
  title: string;
  executionDate: string;
  timeZone: string;
  occurredAt: string;
}

export interface DailyTask {
  taskId: string;
  planId: string;
  title: string;
  executionDate: string;
  createdAt: string;
  projectId: string | null;
  status: "todo";
  source: "temporary";
}

/** Persistence boundary: capture commits the task, plan, history and outbox together. */
export interface TaskStorage {
  capture(command: CaptureCommand): Promise<DailyTask>;
  listDay(date: string): Promise<DailyTask[]>;
}

export class CaptureToday {
  private pending: CaptureCommand | undefined;
  private saving = false;

  constructor(private readonly storage: TaskStorage) {}

  async add(title: string, timeZone: string): Promise<DailyTask> {
    const normalized = title.trim();
    if (!normalized) throw new Error("请填写任务标题");
    if (this.saving) throw new Error("正在保存，请稍候");
    if (
      !this.pending ||
      this.pending.title !== normalized ||
      this.pending.timeZone !== timeZone
    ) {
      const now = new Date();
      this.pending = {
        operationId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        planId: crypto.randomUUID(),
        title: normalized,
        executionDate: calendarDate(now, timeZone),
        timeZone,
        occurredAt: now.toISOString(),
      };
    }
    this.saving = true;
    try {
      const task = await this.storage.capture(this.pending);
      this.pending = undefined;
      return task;
    } finally {
      this.saving = false;
    }
  }

  pendingDateFor(title: string, timeZone: string): string | undefined {
    return this.pending?.title === title.trim() &&
      this.pending.timeZone === timeZone
      ? this.pending.executionDate
      : undefined;
  }

  list(date: string): Promise<DailyTask[]> {
    return this.storage.listDay(date);
  }
}
