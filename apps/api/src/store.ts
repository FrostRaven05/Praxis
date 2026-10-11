import { DatabaseSync } from "node:sqlite";

export interface CaptureCommand {
  operationId: string;
  deviceId: string;
  id: string;
  expectedVersion: number | null;
  rawText: string;
  deleted: boolean;
}
export interface Capture {
  id: string;
  version: number;
  rawText: string;
  deleted: boolean;
  updatedAt: string;
}
export interface CommandResult {
  capture: Capture;
  cursor: number;
}
export interface CaptureChange extends CommandResult {
  deviceId: string;
  operationId: string;
}
export class StoreError extends Error {
  constructor(public readonly code: string) {
    super(code);
  }
}

/** All capture versions, receipts and feed entries commit in one synchronous transaction. */
export class CaptureStore {
  private readonly db: DatabaseSync;
  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS captures (
        owner TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
        raw_text TEXT NOT NULL, deleted INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(owner,id)
      );
      CREATE TABLE IF NOT EXISTS capture_changes (
        owner TEXT NOT NULL, cursor INTEGER NOT NULL, device_id TEXT NOT NULL,
        operation_id TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(owner,cursor), UNIQUE(owner,operation_id)
      );
    `);
  }
  close(): void {
    this.db.close();
  }
  command(owner: string, command: CaptureCommand): CommandResult {
    // Explicit key ordering makes equivalent JSON objects the same logical request.
    const payload = JSON.stringify([
      command.operationId,
      command.deviceId,
      command.id,
      command.expectedVersion,
      command.rawText,
      command.deleted,
    ]);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db
        .prepare(
          "SELECT payload,result FROM capture_changes WHERE owner=? AND operation_id=?",
        )
        .get(owner, command.operationId);
      if (receipt) {
        if (receipt.payload !== payload)
          throw new StoreError("OPERATION_MISMATCH");
        this.db.exec("COMMIT");
        return JSON.parse(String(receipt.result)) as CommandResult;
      }
      const prior = this.db
        .prepare("SELECT version,deleted FROM captures WHERE owner=? AND id=?")
        .get(owner, command.id);
      if (prior && prior.deleted === 1) throw new StoreError("DELETED_CAPTURE");
      if ((prior ? Number(prior.version) : null) !== command.expectedVersion)
        throw new StoreError("VERSION_CONFLICT");
      if (!prior && command.deleted) throw new StoreError("VERSION_CONFLICT");
      const capture: Capture = {
        id: command.id,
        version: prior ? Number(prior.version) + 1 : 1,
        rawText: command.rawText,
        deleted: command.deleted,
        updatedAt: new Date().toISOString(),
      };
      const maximum = this.db
        .prepare(
          "SELECT COALESCE(MAX(cursor),0) AS cursor FROM capture_changes WHERE owner=?",
        )
        .get(owner);
      const cursor = Number(maximum?.cursor ?? 0) + 1;
      const result = { capture, cursor };
      this.db
        .prepare(
          `INSERT INTO captures(owner,id,version,raw_text,deleted,updated_at) VALUES(?,?,?,?,?,?)
        ON CONFLICT(owner,id) DO UPDATE SET version=excluded.version,raw_text=excluded.raw_text,
        deleted=excluded.deleted,updated_at=excluded.updated_at`,
        )
        .run(
          owner,
          capture.id,
          capture.version,
          capture.rawText,
          Number(capture.deleted),
          capture.updatedAt,
        );
      this.db
        .prepare(
          "INSERT INTO capture_changes(owner,cursor,device_id,operation_id,payload,result) VALUES(?,?,?,?,?,?)",
        )
        .run(
          owner,
          cursor,
          command.deviceId,
          command.operationId,
          payload,
          JSON.stringify(result),
        );
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  changes(
    owner: string,
    after: number,
    limit: number,
  ): { changes: CaptureChange[]; cursor: number; hasMore: boolean } {
    const maximum = this.db
      .prepare(
        "SELECT COALESCE(MAX(cursor),0) AS cursor FROM capture_changes WHERE owner=?",
      )
      .get(owner);
    if (after > Number(maximum?.cursor ?? 0))
      throw new StoreError("INVALID_CURSOR");
    const rows = this.db
      .prepare(
        "SELECT device_id,operation_id,result FROM capture_changes WHERE owner=? AND cursor>? ORDER BY cursor LIMIT ?",
      )
      .all(owner, after, limit + 1);
    const changes = rows
      .slice(0, limit)
      .map((row) => ({
        ...(JSON.parse(String(row.result)) as CommandResult),
        deviceId: String(row.device_id),
        operationId: String(row.operation_id),
      }));
    return {
      changes,
      cursor: changes.at(-1)?.cursor ?? after,
      hasMore: rows.length > limit,
    };
  }
}
