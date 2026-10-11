import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { StoreError } from "./store.js";
import { validateGraph } from "./entity-validation.js";
export const entityKinds = [
  "capture",
  "task",
  "project",
  "section",
  "plan",
  "record",
  "habit",
  "habit_check",
  "recurrence",
  "review",
  "view",
  "settings",
  "strategy",
  "decision",
  "focus",
  "desktop_row",
] as const;
export const desktopTables = [
  "labels",
  "task_labels",
  "daily_plan_items",
  "execution_records",
  "day_preferences",
  "day_notes",
  "project_schedules",
  "task_dependencies",
  "record_links",
  "resolutions",
  "project_context",
  "habit_schedules",
  "habit_entries",
  "recurrence_rules",
  "weekly_reviews",
  "review_settings",
  "trash_settings",
  "trash_batches",
  "deletion_tombstones",
  "domain_events",
  "project_events",
  "day_events",
  "content_events",
  "habit_events",
];
export interface Entity {
  id: string;
  kind: string;
  version: number;
  data: Record<string, unknown>;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
}
export interface EntityChange {
  id: string;
  kind: string;
  expectedVersion: number | null;
  data: Record<string, unknown>;
  deleted: boolean;
  createdAt: string;
  baseData?: Record<string, unknown>;
}
export interface EntityCommand {
  operationId: string;
  deviceId: string;
  changes: EntityChange[];
}
export interface EntityResult {
  entities: Entity[];
  cursor: number;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "undefined";
}
function taskDefaults(
  kind: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  if (kind !== "task") {
    const result = { ...data };
    const textKeys =
      kind === "project"
        ? ["outcome", "recoveryNote", "completionCriteria", "blocker"]
        : ["record", "review", "strategy", "decision"].includes(kind)
          ? ["body"]
          : kind === "habit"
            ? ["notes", "trigger", "normalVersion", "minimumVersion"]
            : [];
    const nullableKeys =
      kind === "project"
        ? ["nextActionId", "reviewDate", "dueDate", "archivedAt"]
        : ["record", "review", "strategy", "decision"].includes(kind)
          ? ["projectId", "taskId", "sourceCaptureId"]
          : kind === "habit"
            ? ["projectId"]
            : [];
    for (const key of textKeys) result[key] ??= "";
    for (const key of nullableKeys)
      if (result[key] == null || result[key] === "") result[key] = null;
    if (["record", "review", "strategy", "decision"].includes(kind))
      result.links ??= [];
    if (["record", "review"].includes(kind) && reviewFields(data)) {
      delete result.body;
      if (
        result.desktop &&
        typeof result.desktop === "object" &&
        !Array.isArray(result.desktop)
      ) {
        const desktop = { ...(result.desktop as Record<string, unknown>) };
        delete desktop.body;
        result.desktop = desktop;
      }
    }
    return result;
  }
  const result = { ...data };
  for (const key of [
    "notes",
    "completionCriteria",
    "waitingFor",
    "waitingReason",
  ])
    result[key] ??= "";
  for (const key of [
    "executionDate",
    "startDate",
    "dueDate",
    "followUpDate",
    "projectId",
    "sectionId",
    "parentId",
    "sourceCaptureId",
    "recurrenceId",
    "originalDate",
    "estimatedMinutes",
  ])
    if (result[key] == null || result[key] === "") result[key] = null;
  result.waiting ??= false;
  result.priority ??= 0;
  result.tags ??= [];
  return result;
}
function reviewFields(data: Record<string, unknown>) {
  return [
    "periodStart",
    "periodEnd",
    "achievements",
    "blockers",
    "stopPause",
    "nextFocus",
  ].every((k) => typeof data[k] === "string");
}
function reviewBody(data: Record<string, unknown>) {
  return `期间：${data.periodStart} — ${data.periodEnd}\n\n推进成果\n${data.achievements}\n\n阻塞\n${data.blockers}\n\n停止 / 暂停\n${data.stopPause}\n\n下周重点\n${data.nextFocus}`;
}
function merge(
  base: Record<string, unknown>,
  local: Record<string, unknown>,
  remote: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = Object.create(null) as Record<
    string,
    unknown
  >;
  for (const key of new Set([
    ...Object.keys(base),
    ...Object.keys(local),
    ...Object.keys(remote),
  ])) {
    const b = base[key],
      l = local[key],
      r = remote[key];
    let v: unknown;
    if (canonical(l) === canonical(b)) v = r;
    else if (canonical(r) === canonical(b) || canonical(l) === canonical(r))
      v = l;
    else if (
      b &&
      l &&
      r &&
      [b, l, r].every((x) => typeof x === "object" && !Array.isArray(x))
    )
      v = merge(
        b as Record<string, unknown>,
        l as Record<string, unknown>,
        r as Record<string, unknown>,
      );
    else throw new StoreError("VERSION_CONFLICT");
    if (v !== undefined) result[key] = v;
  }
  return result;
}
export class EntityStore {
  readonly generation = randomUUID();
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS sync_entities(owner TEXT NOT NULL,id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,id));
 CREATE TABLE IF NOT EXISTS sync_entity_versions(owner TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(owner,id,version));
 CREATE TABLE IF NOT EXISTS sync_entity_changes(owner TEXT NOT NULL,cursor INTEGER NOT NULL,operation_id TEXT NOT NULL,device_id TEXT NOT NULL,payload TEXT NOT NULL,result TEXT NOT NULL,PRIMARY KEY(owner,cursor),UNIQUE(owner,operation_id));
 CREATE TABLE IF NOT EXISTS sync_entity_migrations(name TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS sync_entity_upgrades(owner TEXT PRIMARY KEY);`);
    this.seedCaptures();
  }
  upgraded(owner: string) {
    return !!this.db
      .prepare("SELECT 1 FROM sync_entity_upgrades WHERE owner=?")
      .get(owner);
  }
  close() {
    this.db.close();
  }
  private seedCaptures() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (
        !this.db
          .prepare(
            "SELECT 1 FROM sync_entity_migrations WHERE name='captures-v1'",
          )
          .get()
      ) {
        const exists = this.db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='captures'",
          )
          .get();
        if (exists)
          for (const row of this.db
            .prepare("SELECT * FROM captures ORDER BY owner,id")
            .all()) {
            const owner = String(row.owner);
            const entity: Entity = {
              id: String(row.id),
              kind: "capture",
              version: Number(row.version),
              data: { rawText: String(row.raw_text), status: "inbox" },
              deleted: !!row.deleted,
              createdAt: String(row.updated_at),
              updatedAt: String(row.updated_at),
            };
            if (
              !this.db
                .prepare("SELECT 1 FROM sync_entities WHERE owner=? AND id=?")
                .get(owner, entity.id)
            )
              this.save(
                owner,
                {
                  operationId: randomUUID(),
                  deviceId: "00000000-0000-4000-8000-000000000000",
                  changes: [],
                },
                [entity],
              );
          }
        this.db
          .prepare("INSERT INTO sync_entity_migrations VALUES('captures-v1')")
          .run();
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  private save(
    owner: string,
    command: EntityCommand,
    entities: Entity[],
  ): EntityResult {
    const cursor =
      Number(
        this.db
          .prepare(
            "SELECT COALESCE(MAX(cursor),0) AS n FROM sync_entity_changes WHERE owner=?",
          )
          .get(owner)?.n ?? 0,
      ) + 1;
    const result = { entities, cursor };
    if (Buffer.byteLength(JSON.stringify(result)) > 14 * 1024 * 1024)
      throw new StoreError("BODY_TOO_LARGE");
    for (const e of entities) {
      const payload = JSON.stringify(e);
      this.db
        .prepare(
          "INSERT INTO sync_entities VALUES(?,?,?) ON CONFLICT(owner,id) DO UPDATE SET payload=excluded.payload",
        )
        .run(owner, e.id, payload);
      this.db
        .prepare("INSERT INTO sync_entity_versions VALUES(?,?,?,?)")
        .run(owner, e.id, e.version, payload);
    }
    this.db
      .prepare("INSERT INTO sync_entity_changes VALUES(?,?,?,?,?,?)")
      .run(
        owner,
        cursor,
        command.operationId,
        command.deviceId,
        canonical(command),
        JSON.stringify(result),
      );
    return result;
  }
  command(owner: string, command: EntityCommand): EntityResult {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const receipt = this.db
        .prepare(
          "SELECT payload,result FROM sync_entity_changes WHERE owner=? AND operation_id=?",
        )
        .get(owner, command.operationId);
      if (receipt) {
        if (receipt.payload !== canonical(command))
          throw new StoreError("OPERATION_MISMATCH");
        this.db.exec("COMMIT");
        return JSON.parse(String(receipt.result)) as EntityResult;
      }
      if (
        new Set(command.changes.map((c) => c.id)).size !==
        command.changes.length
      )
        throw new StoreError("DUPLICATE_ENTITY");
      const all = this.db
        .prepare("SELECT payload FROM sync_entities WHERE owner=?")
        .all(owner)
        .map((r) => JSON.parse(String(r.payload)) as Entity);
      const graph = new Map(all.map((e) => [e.id, e]));
      const entities: Entity[] = [];
      const now = new Date().toISOString();
      for (const c of command.changes) {
        const prior = graph.get(c.id);
        let data = c.data;
        if (prior && prior.kind !== c.kind)
          throw new StoreError("KIND_MISMATCH");
        if ((prior?.version ?? null) !== c.expectedVersion) {
          if (
            !prior ||
            !c.expectedVersion ||
            !c.baseData ||
            prior.deleted ||
            c.deleted
          )
            throw new StoreError("VERSION_CONFLICT");
          const history = this.db
            .prepare(
              "SELECT payload FROM sync_entity_versions WHERE owner=? AND id=? AND version=?",
            )
            .get(owner, c.id, c.expectedVersion);
          if (!history) throw new StoreError("VERSION_CONFLICT");
          const base = JSON.parse(String(history.payload)) as Entity;
          if (base.deleted || canonical(base.data) !== canonical(c.baseData))
            throw new StoreError("VERSION_CONFLICT");
          data = merge(
            taskDefaults(c.kind, base.data),
            taskDefaults(c.kind, c.data),
            taskDefaults(c.kind, prior.data),
          );
        }
        // Initial sync and restored backups can contain locally deleted entities.
        // Persist their tombstones so every device sees the same deletion; the
        // null expected version above still prevents overwriting a remote row.
        if (
          c.kind === "desktop_row" &&
          (!desktopTables.includes(String(data.table)) ||
            !data.row ||
            typeof data.row !== "object" ||
            Array.isArray(data.row))
        )
          throw new StoreError("INVALID_GRAPH");
        if (["record", "review"].includes(c.kind) && reviewFields(data))
          data = {
            ...data,
            body: reviewBody(data),
            ...(data.desktop &&
            typeof data.desktop === "object" &&
            !Array.isArray(data.desktop)
              ? {
                  desktop: {
                    ...(data.desktop as Record<string, unknown>),
                    body: reviewBody(data),
                  },
                }
              : {}),
          };
        const e: Entity = {
          id: c.id,
          kind: c.kind,
          version: (prior?.version ?? 0) + 1,
          data,
          deleted: c.deleted,
          createdAt: prior?.createdAt ?? c.createdAt,
          updatedAt: now,
        };
        graph.set(e.id, e);
        entities.push(e);
      }
      validateGraph([...graph.values()]);
      const result = this.save(owner, command, entities);
      this.db
        .prepare("INSERT OR IGNORE INTO sync_entity_upgrades VALUES(?)")
        .run(owner);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  changes(owner: string, after: number, limit: number) {
    const max = Number(
      this.db
        .prepare(
          "SELECT COALESCE(MAX(cursor),0) AS n FROM sync_entity_changes WHERE owner=?",
        )
        .get(owner)?.n ?? 0,
    );
    if (after > max) throw new StoreError("INVALID_CURSOR");
    const rows = this.db
      .prepare(
        "SELECT device_id,operation_id,result FROM sync_entity_changes WHERE owner=? AND cursor>? ORDER BY cursor LIMIT ?",
      )
      .iterate(owner, after, limit + 1);
    const changes: (EntityResult & {
      deviceId: string;
      operationId: string;
    })[] = [];
    let bytes = 128,
      hasMore = false;
    for (const row of rows) {
      const entry = {
        ...(JSON.parse(String(row.result)) as EntityResult),
        deviceId: String(row.device_id),
        operationId: String(row.operation_id),
      };
      const size = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (changes.length >= limit || bytes + size > 15 * 1024 * 1024) {
        hasMore = true;
        break;
      }
      bytes += size;
      changes.push(entry);
    }
    return {
      changes,
      cursor: changes.at(-1)?.cursor ?? after,
      hasMore,
      generation: this.generation,
    };
  }
  snapshot(
    owner: string,
    at: number | undefined,
    afterId: string,
    limit: number,
  ) {
    const maximum = Number(
      this.db
        .prepare(
          "SELECT COALESCE(MAX(cursor),0) AS n FROM sync_entity_changes WHERE owner=?",
        )
        .get(owner)?.n ?? 0,
    );
    const cursor = at ?? maximum;
    if (cursor > maximum) throw new StoreError("INVALID_CURSOR");
    const graph = new Map<string, Entity>();
    for (const r of this.db
      .prepare(
        "SELECT result FROM sync_entity_changes WHERE owner=? AND cursor<=? ORDER BY cursor",
      )
      .iterate(owner, cursor)) {
      const result = JSON.parse(String(r.result)) as EntityResult;
      for (const e of result.entities) graph.set(e.id, e);
    }
    const all = [...graph.values()].sort((a, b) =>
      a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    if (afterId && !graph.has(afterId)) throw new StoreError("INVALID_CURSOR");
    const entities: Entity[] = [];
    let bytes = 128,
      hasMore = false;
    for (const e of all) {
      if (e.id <= afterId) continue;
      const size = Buffer.byteLength(JSON.stringify(e)) + 1;
      if (entities.length >= limit || bytes + size > 15 * 1024 * 1024) {
        hasMore = true;
        break;
      }
      bytes += size;
      entities.push(e);
    }
    return {
      entities,
      cursor,
      generation: this.generation,
      hasMore,
      nextId: entities.at(-1)?.id ?? afterId,
    };
  }
}
