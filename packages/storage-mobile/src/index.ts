import { recordStorageError } from "./diagnostics";
import {
  calendarDate,
  type CaptureCommand,
  type DailyTask,
  type TaskStorage,
} from "@praxis/application";

export interface Connection {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ values?: Record<string, unknown>[] }>;
  run(sql: string, values?: unknown[], transaction?: boolean): Promise<unknown>;
  beginTransaction(): Promise<unknown>;
  commitTransaction(): Promise<unknown>;
  rollbackTransaction(): Promise<unknown>;
}
const projection = `SELECT t.id AS taskId, p.id AS planId, t.title, p.execution_date AS executionDate,
t.created_at AS createdAt, t.project_id AS projectId, t.status, t.source
FROM tasks t JOIN daily_plan_items p ON p.task_id=t.id AND p.owner_id=t.owner_id`;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function validate(command: CaptureCommand) {
  if (
    ![command.taskId, command.planId, command.operationId].every((id) =>
      uuid.test(id),
    ) ||
    !command.title.trim() ||
    calendarDate(new Date(command.occurredAt), command.timeZone) !==
      command.executionDate
  )
    throw new Error("无效的任务录入数据");
}

/** Serializes all access to the single native connection, including reads. */
export class MobileStorage implements TaskStorage {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly connect: () => Promise<Connection>) {}
  private serial<T>(action: (db: Connection) => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => action(await this.connect()));
    this.queue = result.catch(() => undefined);
    return result;
  }
  capture(command: CaptureCommand): Promise<DailyTask> {
    return this.serial(async (db) => {
      validate(command);
      const payload = JSON.stringify(command);
      await db.beginTransaction();
      try {
        await db.run(
          "INSERT OR IGNORE INTO local_profile(singleton, owner_id, device_id) VALUES (1, ?, ?)",
          [crypto.randomUUID(), crypto.randomUUID()],
          false,
        );
        const identity = (
          await db.query(
            "SELECT owner_id, device_id FROM local_profile WHERE singleton=1",
          )
        ).values?.[0];
        if (!identity) throw new Error("本机身份不可用");
        const owner = identity.owner_id;
        const existing = (
          await db.query(
            "SELECT payload FROM sync_outbox WHERE operation_id=? AND owner_id=?",
            [command.operationId, owner],
          )
        ).values?.[0];
        if (existing) {
          if (existing.payload !== payload)
            throw new Error("操作编号已用于其他内容");
        } else {
          await db.run(
            "INSERT INTO tasks(id,owner_id,title,status,source,created_at) VALUES (?,?,?,'todo','temporary',?)",
            [command.taskId, owner, command.title.trim(), command.occurredAt],
            false,
          );
          await db.run(
            "INSERT INTO daily_plan_items(id,owner_id,task_id,execution_date,time_zone,created_at) VALUES (?,?,?,?,?,?)",
            [
              command.planId,
              owner,
              command.taskId,
              command.executionDate,
              command.timeZone,
              command.occurredAt,
            ],
            false,
          );
          await db.run(
            "INSERT INTO domain_events(id,owner_id,task_id,kind,occurred_at,payload) VALUES (?,?,?,'task_captured',?,?)",
            [
              command.operationId,
              owner,
              command.taskId,
              command.occurredAt,
              payload,
            ],
            false,
          );
          await db.run(
            "INSERT INTO sync_outbox(operation_id,owner_id,device_id,protocol_version,kind,payload,created_at) VALUES (?,?,?,1,'capture_task',?,?)",
            [
              command.operationId,
              owner,
              identity.device_id,
              payload,
              command.occurredAt,
            ],
            false,
          );
        }
        const row = (
          await db.query(projection + " WHERE p.id=? AND p.owner_id=?", [
            command.planId,
            owner,
          ])
        ).values?.[0];
        if (!row) throw new Error("任务读取失败");
        await db.commitTransaction();
        return row as unknown as DailyTask;
      } catch (error) {
        try {
          await db.rollbackTransaction();
        } catch {
          /* Preserve original failure for retry. */
        }
        throw error;
      }
    }).catch((error: unknown) => {
      recordStorageError(
        "capture",
        error,
        uuid.test(command.operationId) ? command.operationId : undefined,
      );
      throw new Error(
        "未能确认保存结果，请检查存储空间后重试。重试不会重复录入。",
        { cause: error },
      );
    });
  }
  listDay(date: string): Promise<DailyTask[]> {
    return this.serial(async (db) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("日期格式无效");
      const rows = await db.query(
        projection + " WHERE p.execution_date=? ORDER BY p.created_at,p.id",
        [date],
      );
      return (rows.values ?? []) as unknown as DailyTask[];
    }).catch((error: unknown) => {
      recordStorageError("list", error);
      throw new Error("无法读取本机任务，请重试。", { cause: error });
    });
  }
}
