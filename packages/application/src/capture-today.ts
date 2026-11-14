import { calendarDate } from "./calendar-date";
import { validCalendarDate } from "./edit-task";

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
  important?: boolean;
  deadline?: string | null;
  taskId: string;
  planId: string;
  title: string;
  executionDate: string;
  createdAt: string;
  projectId: string | null;
  status: "todo" | "in_progress" | "blocked" | "completed" | "cancelled";
  statusReason?: string;
  projectStatus?: string | null;
  version?: number;
  isFocus?: boolean;
  focusRank?: number;
  dayPeriod?: import("./day-schedule").DayPeriod;
  dayRank?: number;
  estimatedMinutes?: number | null;
  activeCompletionId?: string | null;
  completionDate?: string | null;
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
  private requestedDate: string | undefined;

  constructor(private readonly storage: TaskStorage) {}

  async add(
    title: string,
    timeZone: string,
    executionDate?: string,
  ): Promise<DailyTask> {
    const normalized = title.trim();
    if (!normalized) throw new Error("请填写任务标题");
    if (executionDate !== undefined && !validCalendarDate(executionDate))
      throw new Error("请选择有效的安排日期");
    if (this.saving) throw new Error("正在保存，请稍候");
    if (
      !this.pending ||
      this.pending.title !== normalized ||
      this.pending.timeZone !== timeZone ||
      this.requestedDate !== executionDate
    ) {
      const now = new Date();
      this.pending = {
        operationId: crypto.randomUUID(),
        taskId: crypto.randomUUID(),
        planId: crypto.randomUUID(),
        title: normalized,
        executionDate: executionDate ?? calendarDate(now, timeZone),
        timeZone,
        occurredAt: now.toISOString(),
      };
      this.requestedDate = executionDate;
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
