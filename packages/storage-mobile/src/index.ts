import {
  resolveLan,
  bindLan,
  lanState,
  prepareLan,
  ackLan,
  blockLan,
  pullLan,
  type LanBinding,
  type LanCommand,
  type LanCapture,
  type LanPage,
} from "./lan";
export * from "./lan";
import { recordStorageError } from "./diagnostics";
import {
  readWorkspace,
  changeWorkspace,
  exportWorkspace,
  importWorkspace,
  listWorkspaces,
  switchWorkspace,
  type WorkspaceCommand,
} from "./workspace";
export * from "./workspace";
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
export interface MobileCapture {
  id: string;
  rawText: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface SaveCaptureCommand {
  operationId: string;
  id: string;
  expectedVersion: number | null;
  rawText: string;
  occurredAt: string;
}
export const MAX_CAPTURE_CHARACTERS = 100_000;
export class CaptureRejectedError extends Error {}
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
  lanBind(b: LanBinding) {
    return this.serial((db) => bindLan(db, b));
  }
  lanResolve(
    id: string,
    keep: boolean,
    localVersion: number,
    remoteVersion: number,
    operationId: string,
  ) {
    return this.serial((db) =>
      resolveLan(db, id, keep, localVersion, remoteVersion, operationId),
    );
  }
  lanState() {
    return this.serial(lanState);
  }
  lanPrepare() {
    return this.serial(prepareLan);
  }
  lanAck(command: LanCommand, capture: LanCapture) {
    return this.serial((db) => ackLan(db, command, capture));
  }
  lanBlock(id: string) {
    return this.serial((db) => blockLan(db, id));
  }
  lanPull(page: LanPage) {
    return this.serial((db) => pullLan(db, page));
  }
  workspaceSnapshot() {
    return this.serial(readWorkspace);
  }
  workspaceCommand(command: WorkspaceCommand) {
    return this.serial((db) => changeWorkspace(db, command));
  }
  workspaceExport() {
    return this.serial(exportWorkspace);
  }
  workspaceImport(json: string, operationId: string) {
    return this.serial((db) => importWorkspace(db, json, operationId));
  }
  workspaceList() {
    return this.serial(listWorkspaces);
  }
  workspaceSwitch(id: string) {
    return this.serial((db) => switchWorkspace(db, id));
  }
  saveCapture(command: SaveCaptureCommand): Promise<void> {
    return this.serial(async (db) => {
      if (
        !uuid.test(command.id) ||
        !uuid.test(command.operationId) ||
        !command.rawText.trim() ||
        Array.from(command.rawText).length > MAX_CAPTURE_CHARACTERS ||
        !Number.isFinite(Date.parse(command.occurredAt)) ||
        (command.expectedVersion !== null &&
          (!Number.isInteger(command.expectedVersion) ||
            command.expectedVersion < 1))
      )
        throw new CaptureRejectedError(
          "原文不能为空，且最多支持 100,000 个字符。",
        );
      await db.beginTransaction();
      try {
        await db.run(
          "INSERT OR IGNORE INTO local_profile(singleton,owner_id,device_id) VALUES(1,?,?)",
          [crypto.randomUUID(), crypto.randomUUID()],
          false,
        );
        const identity = (
          await db.query(
            "SELECT owner_id,device_id FROM local_profile WHERE singleton=1",
          )
        ).values?.[0];
        if (!identity) throw new Error("本机身份不可用");
        const payload = JSON.stringify(command);
        const replay = (
          await db.query(
            "SELECT payload FROM capture_events WHERE operation_id=? AND owner_id=?",
            [command.operationId, identity.owner_id],
          )
        ).values?.[0];
        if (replay) {
          if (replay.payload !== payload)
            throw new CaptureRejectedError(
              "操作编号已用于其他内容，请另存原文。",
            );
        } else {
          const previous = (
            await db.query(
              "SELECT version FROM captures WHERE id=? AND owner_id=?",
              [command.id, identity.owner_id],
            )
          ).values?.[0];
          if ((previous?.version ?? null) !== command.expectedVersion)
            throw new CaptureRejectedError(
              "收集项已更改；当前输入已保留，请另存原文后核对最新版本。",
            );
          if (previous)
            await db.run(
              "UPDATE captures SET raw_text=?, version=version+1, updated_at=? WHERE id=? AND owner_id=?",
              [
                command.rawText,
                command.occurredAt,
                command.id,
                identity.owner_id,
              ],
              false,
            );
          else
            await db.run(
              "INSERT INTO captures(id,owner_id,raw_text,created_at,updated_at) VALUES(?,?,?,?,?)",
              [
                command.id,
                identity.owner_id,
                command.rawText,
                command.occurredAt,
                command.occurredAt,
              ],
              false,
            );
          await db.run(
            "INSERT INTO capture_events(operation_id,owner_id,capture_id,kind,payload,occurred_at) VALUES(?,?,?,'save_capture',?,?)",
            [
              command.operationId,
              identity.owner_id,
              command.id,
              payload,
              command.occurredAt,
            ],
            false,
          );
          await db.run(
            "INSERT INTO sync_outbox(operation_id,owner_id,device_id,protocol_version,kind,payload,created_at) VALUES(?,?,?,1,'save_capture',?,?)",
            [
              command.operationId,
              identity.owner_id,
              identity.device_id,
              payload,
              command.occurredAt,
            ],
            false,
          );
        }
        await db.commitTransaction();
      } catch (error) {
        await db.rollbackTransaction().catch(() => undefined);
        throw error;
      }
    }).catch((error: unknown) => {
      if (error instanceof CaptureRejectedError) throw error;
      recordStorageError(
        "capture",
        error,
        uuid.test(command.operationId) ? command.operationId : undefined,
      );
      throw new Error(
        "未能确认保存，请保留输入并重试；重复重试不会产生副本。",
        { cause: error },
      );
    });
  }
  listCaptures(): Promise<MobileCapture[]> {
    return this.serial(
      async (db) =>
        ((
          await db.query(
            "SELECT id,raw_text AS rawText,version,created_at AS createdAt,updated_at AS updatedAt FROM captures WHERE owner_id=(SELECT owner_id FROM local_profile WHERE singleton=1) ORDER BY created_at DESC,id",
          )
        ).values ?? []) as unknown as MobileCapture[],
    );
  }
  captureQueueCount(): Promise<number> {
    return this.serial(async (db) =>
      Number(
        (
          await db.query(
            "SELECT count(*) AS count FROM sync_outbox WHERE kind='save_capture' AND owner_id=(SELECT owner_id FROM local_profile WHERE singleton=1)",
          )
        ).values?.[0]?.count ?? 0,
      ),
    );
  }
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
