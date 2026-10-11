import type { Connection } from "./index";
import { lanState } from "./lan";
import { structuredReview, reviewBody } from "./structured-review";
import {
  readWorkspace,
  changeWorkspace,
  validateGraph,
  workspaceKinds,
  type WorkspaceEntity,
} from "./workspace";
export interface EntityCommand {
  operationId: string;
  deviceId: string;
  changes: {
    id: string;
    kind: string;
    expectedVersion: number | null;
    data: Record<string, unknown>;
    baseData?: Record<string, unknown>;
    deleted: boolean;
    createdAt: string;
  }[];
}
export interface EntityBatch {
  entities: WorkspaceEntity[];
  cursor: number;
  operationId: string;
  deviceId: string;
}
export interface EntityPage {
  changes: EntityBatch[];
  cursor: number;
  hasMore: boolean;
  generation?: string;
}
const run = (db: Connection, sql: string, args: unknown[] = []) =>
  db.run(sql, args, false);
const one = async (db: Connection, sql: string, args: unknown[] = []) =>
  (await db.query(sql, args)).values?.[0];
const json = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).sort(([a], [b]) => a.localeCompare(b)),
        )
      : v,
  );
const equal = (a: unknown, b: unknown) => json(a) === json(b);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function mergeValue(
  local: unknown,
  base: unknown,
  remote: unknown,
): { ok: boolean; value?: unknown } {
  if (equal(local, base)) return { ok: true, value: remote };
  if (equal(remote, base) || equal(local, remote))
    return { ok: true, value: local };
  if (!object(local) || !object(base) || !object(remote)) return { ok: false };
  const value: Record<string, unknown> = {};
  for (const key of new Set([
    ...Object.keys(local),
    ...Object.keys(base),
    ...Object.keys(remote),
  ])) {
    const result = mergeValue(local[key], base[key], remote[key]);
    if (!result.ok) return result;
    if (result.value !== undefined) value[key] = result.value;
  }
  return { ok: true, value };
}
const same = (a: WorkspaceEntity, b: WorkspaceEntity) =>
  a.kind === b.kind &&
  a.deleted === b.deleted &&
  equal(taskDefaults(a.kind, a.data), taskDefaults(b.kind, b.data));
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
    if (["record", "review"].includes(kind) && structuredReview(data)) {
      delete result.body;
      if (object(result.desktop)) {
        const desktop = { ...result.desktop };
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
async function tx<T>(db: Connection, fn: () => Promise<T>): Promise<T> {
  await db.beginTransaction();
  try {
    const result = await fn();
    await db.commitTransaction();
    return result;
  } catch (e) {
    await db.rollbackTransaction().catch(() => undefined);
    throw e;
  }
}
function checkEntities(value: unknown): asserts value is WorkspaceEntity[] {
  if (!Array.isArray(value) || value.length > 10000)
    throw Error("同步条目无效");
  const ids = new Set<string>();
  for (const e of value) {
    if (
      !e ||
      typeof e.id !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        e.id,
      ) ||
      !workspaceKinds.includes(e.kind) ||
      ids.has(e.id) ||
      !Number.isSafeInteger(e.version) ||
      e.version < 1 ||
      !e.data ||
      typeof e.data !== "object" ||
      Array.isArray(e.data) ||
      typeof e.deleted !== "boolean" ||
      !Number.isFinite(Date.parse(e.createdAt)) ||
      !Number.isFinite(Date.parse(e.updatedAt))
    )
      throw Error("同步条目无效");
    ids.add(e.id);
  }
}
async function shadow(
  db: Connection,
  id: string,
): Promise<WorkspaceEntity | null> {
  const r = await one(
    db,
    "SELECT remote FROM mobile_entity_sync_shadow WHERE id=?",
    [id],
  );
  return r ? JSON.parse(String(r.remote)) : null;
}
async function setShadow(db: Connection, e: WorkspaceEntity) {
  await run(
    db,
    "INSERT OR REPLACE INTO mobile_entity_sync_shadow VALUES(?,?)",
    [e.id, JSON.stringify(e)],
  );
}
async function write(
  db: Connection,
  e: WorkspaceEntity,
  old?: WorkspaceEntity,
) {
  const review = structuredReview(e.data);
  const body = review ? reviewBody(review) : null;
  await run(
    db,
    `INSERT INTO mobile_entities(workspace_id,id,kind,version,data,deleted,created_at,updated_at) VALUES((SELECT workspace_id FROM mobile_lan_binding WHERE singleton=1),?,?,?,?,?,?,?) ON CONFLICT(workspace_id,id) DO UPDATE SET kind=excluded.kind,version=excluded.version,data=excluded.data,deleted=excluded.deleted,updated_at=excluded.updated_at`,
    [
      e.id,
      e.kind,
      Math.max(e.version, (old?.version ?? 0) + 1),
      JSON.stringify(
        review
          ? {
              ...e.data,
              body,
              ...(object(e.data.desktop)
                ? { desktop: { ...e.data.desktop, body } }
                : {}),
            }
          : e.data,
      ),
      Number(e.deleted),
      e.createdAt,
      e.updatedAt,
    ],
  );
}
async function history(db: Connection, id: string, payload: unknown) {
  await run(
    db,
    "INSERT OR IGNORE INTO mobile_operations VALUES(?,(SELECT workspace_id FROM mobile_lan_binding WHERE singleton=1),?,?)",
    [id, JSON.stringify(payload), new Date().toISOString()],
  );
}
function blockedIds(
  entities: WorkspaceEntity[],
  conflicts: { batch: EntityBatch }[],
): Set<string> {
  return connectedIds(
    entities,
    conflicts.flatMap((c) => c.batch.entities),
  );
}
function connectedIds(
  entities: WorkspaceEntity[],
  seeds: WorkspaceEntity[],
): Set<string> {
  const blocked = new Set(seeds.map((e) => e.id));
  const all = [...entities, ...seeds];
  const ids = new Set(all.map((e) => e.id));
  const references = (value: unknown): string[] =>
    typeof value === "string"
      ? ids.has(value)
        ? [value]
        : []
      : Array.isArray(value)
        ? value.flatMap(references)
        : object(value)
          ? Object.values(value).flatMap(references)
          : [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const e of all) {
      const refs = references(e.data);
      if (blocked.has(e.id) || refs.some((id) => blocked.has(id))) {
        for (const id of [e.id, ...refs])
          if (!blocked.has(id)) {
            blocked.add(id);
            changed = true;
          }
      }
    }
  }
  return blocked;
}
export async function entityState(db: Connection) {
  const legacy = await lanState(db);
  const r = await one(
    db,
    "SELECT * FROM mobile_entity_sync_state WHERE singleton=1",
  );
  const conflicts =
    (
      await db.query(
        "SELECT * FROM mobile_entity_sync_conflicts ORDER BY rowid",
      )
    ).values ?? [];
  const snapshot = await readWorkspace(db);
  return {
    active: legacy.active,
    binding: legacy.binding,
    cursor: Number(r?.cursor ?? 0),
    lastSuccess: r?.last_success ? String(r.last_success) : null,
    generation: r?.generation ? String(r.generation) : null,
    rejected: await one(db, "SELECT * FROM mobile_entity_sync_rejected"),
    rejectedLocal: snapshot.entities,
    conflicts: conflicts.map((c) => {
      const batch = JSON.parse(String(c.payload)) as EntityBatch;
      const local = snapshot.entities.filter((e) =>
        batch.entities.some((r) => r.id === e.id),
      );
      return {
        operationId: String(c.operation_id),
        batch,
        local,
        expected: JSON.stringify({
          batch,
          versions: local.map((e) => [e.id, e.version]),
        }),
      };
    }),
  };
}
export async function prepareEntities(
  db: Connection,
): Promise<EntityCommand | null> {
  return tx(db, async () => {
    const state = await entityState(db);
    if (!state.active) return null;
    const pending = await one(
      db,
      "SELECT payload FROM mobile_entity_sync_pending",
    );
    if (pending) return JSON.parse(String(pending.payload));
    let changes: EntityCommand["changes"] = [];
    const snapshot = await readWorkspace(db),
      blocked = blockedIds(snapshot.entities, state.conflicts);
    for (const e of snapshot.entities) {
      if (blocked.has(e.id)) continue;
      const remote = await shadow(db, e.id);
      if (remote && same(e, remote)) continue;
      changes.push({
        id: e.id,
        kind: e.kind,
        expectedVersion: remote?.version ?? null,
        data: e.data,
        ...(remote ? { baseData: remote.data } : {}),
        deleted: e.deleted,
        createdAt: remote?.createdAt ?? e.createdAt,
      });
    }
    if (!changes.length) return null;
    // Keep graph mutations atomic without putting independent projects into one
    // conflict unit. Include both baselines and current references: moving a task
    // between projects must include cleanup in the former project as well.
    const baselines = (
      (await db.query("SELECT remote FROM mobile_entity_sync_shadow")).values ??
      []
    ).map((r) => JSON.parse(String(r.remote)) as WorkspaceEntity);
    const component = connectedIds(
      [...snapshot.entities, ...baselines],
      [snapshot.entities.find((e) => e.id === changes[0]!.id)!],
    );
    changes = changes.filter((c) => component.has(c.id));
    const rejected = await one(
      db,
      "SELECT payload FROM mobile_entity_sync_rejected",
    );
    if (
      rejected &&
      equal(
        (JSON.parse(String(rejected.payload)) as EntityCommand).changes,
        changes,
      )
    )
      return null;
    if (rejected) await run(db, "DELETE FROM mobile_entity_sync_rejected");
    if (changes.length > 10000)
      throw Error("同步批次超过 10000 项，请联系维护者");
    const command = {
      operationId: crypto.randomUUID(),
      deviceId: String(state.binding!.device_id),
      changes,
    };
    await run(db, "INSERT INTO mobile_entity_sync_pending VALUES(1,?)", [
      JSON.stringify(command),
    ]);
    return command;
  });
}
// Three-way field merge retains independent local edits; a delete or a same-field collision is explicit.
function merge(
  local: WorkspaceEntity,
  base: WorkspaceEntity,
  remote: WorkspaceEntity,
): WorkspaceEntity | null {
  if (same(local, base)) return remote;
  if (same(local, remote)) return remote;
  if (
    local.kind !== remote.kind ||
    local.deleted !== base.deleted ||
    remote.deleted !== base.deleted
  )
    return null;
  const merged = mergeValue(
    taskDefaults(local.kind, local.data),
    taskDefaults(base.kind, base.data),
    taskDefaults(remote.kind, remote.data),
  );
  const mergedData = merged.value as Record<string, unknown>;
  const review = merged.ok ? structuredReview(mergedData) : null;
  return merged.ok
    ? {
        ...remote,
        data: review
          ? {
              ...mergedData,
              body: reviewBody(review),
              ...(object(mergedData.desktop)
                ? {
                    desktop: {
                      ...mergedData.desktop,
                      body: reviewBody(review),
                    },
                  }
                : {}),
            }
          : mergedData,
      }
    : null;
}
async function applyBatch(
  db: Connection,
  batch: EntityBatch,
  ack?: EntityCommand,
  rebase = false,
) {
  checkEntities(batch.entities);
  const snapshot = await readWorkspace(db);
  const locals = new Map(snapshot.entities.map((e) => [e.id, e]));
  const next = new Map(locals);
  const blocked = blockedIds(
    snapshot.entities,
    (await entityState(db)).conflicts,
  );
  let conflict = batch.entities.some((e) => blocked.has(e.id));
  for (const remote of batch.entities) {
    const base = await shadow(db, remote.id);
    if (!rebase && base && base.version > remote.version) continue;
    const local = locals.get(remote.id);
    let merged = remote;
    if (rebase && local && base && base.version > remote.version)
      merged = local;
    else if (local) {
      const sent = ack?.changes.find((c) => c.id === remote.id);
      const mergeBase = sent
        ? { ...local, data: sent.data, deleted: sent.deleted }
        : base;
      if (mergeBase) {
        const result = merge(local, mergeBase, remote);
        if (!result) {
          conflict = true;
          continue;
        }
        merged = result;
      } else if (!same(local, remote)) {
        // v1 migration: seeded server captures carry raw text only; preserve existing clarification metadata.
        const legacy =
          remote.kind === "capture"
            ? await one(db, "SELECT remote FROM mobile_lan_shadow WHERE id=?", [
                remote.id,
              ])
            : null;
        const previous = legacy ? JSON.parse(String(legacy.remote)) : null;
        const migrated = previous
          ? merge(
              local,
              {
                ...remote,
                data: { rawText: previous.rawText, status: "inbox" },
                deleted: previous.deleted,
              },
              remote,
            )
          : null;
        if (migrated) merged = migrated;
        else {
          conflict = true;
          continue;
        }
      }
    }
    next.set(remote.id, {
      ...merged,
      version: Math.max(merged.version, local?.version ?? 0),
    });
  }
  // Output receipt versions are device-local optimistic revisions, not server CAS versions.
  // Keep local revisions high enough to preserve the original clarification undo guard.
  for (const e of next.values())
    if (e.kind === "capture" && Array.isArray(e.data.outputs)) {
      for (const output of e.data.outputs as {
        id: string;
        version: number;
      }[]) {
        const target = next.get(output.id);
        if (
          target &&
          Number.isSafeInteger(output.version) &&
          target.version < output.version
        )
          next.set(target.id, { ...target, version: output.version });
      }
    }
  try {
    validateGraph([...next.values()]);
  } catch {
    conflict = true;
  }
  if (conflict) {
    await run(
      db,
      "INSERT OR REPLACE INTO mobile_entity_sync_conflicts VALUES(?,?)",
      [batch.operationId, JSON.stringify(batch)],
    );
    return;
  }
  for (const remote of batch.entities) {
    const prior = await shadow(db, remote.id);
    if (!rebase && prior && prior.version > remote.version) continue;
    const local = locals.get(remote.id);
    const value = next.get(remote.id)!;
    if (
      !local ||
      !same(local, value) ||
      value.version > local.version ||
      (structuredReview(value.data) &&
        (local.data.body !== value.data.body ||
          (object(local.data.desktop) &&
            object(value.data.desktop) &&
            local.data.desktop.body !== value.data.desktop.body)))
    )
      await write(db, value, local);
    await setShadow(db, remote);
  }
  for (const [id, e] of next)
    if (
      !batch.entities.some((r) => r.id === id) &&
      e.version > (locals.get(id)?.version ?? 0)
    )
      await run(
        db,
        "UPDATE mobile_entities SET version=? WHERE workspace_id=(SELECT workspace_id FROM mobile_lan_binding WHERE singleton=1) AND id=?",
        [e.version, id],
      );
  await history(db, batch.operationId, {
    kind: "entity_sync_pull",
    before: batch.entities.map((e) => locals.get(e.id) ?? null),
    after: batch.entities,
  });
}
export async function ackEntities(
  db: Connection,
  command: EntityCommand,
  entities: WorkspaceEntity[],
) {
  return tx(db, async () => {
    checkEntities(entities);
    const pending = await one(
      db,
      "SELECT payload FROM mobile_entity_sync_pending",
    );
    if (!pending || !equal(JSON.parse(String(pending.payload)), command))
      throw Error("上传确认与冻结批次不一致");
    if (
      entities.length !== command.changes.length ||
      entities.some(
        (e) => !command.changes.some((c) => c.id === e.id && c.kind === e.kind),
      )
    )
      throw Error("上传确认条目不一致");
    await applyBatch(
      db,
      {
        entities,
        cursor: 0,
        operationId: command.operationId,
        deviceId: command.deviceId,
      },
      command,
    );
    await run(db, "DELETE FROM mobile_entity_sync_pending");
    for (const entity of entities)
      if (entity.kind === "capture")
        await run(db, "DELETE FROM mobile_lan_pending WHERE id=?", [entity.id]);
  });
}
export async function pullEntities(db: Connection, page: EntityPage) {
  return tx(db, async () => {
    const state = await entityState(db);
    if (!state.active) throw Error("请切回配对工作空间");
    if (
      page.generation &&
      state.generation &&
      page.generation !== state.generation
    )
      throw Error("GENERATION_CHANGED");
    if (
      !page ||
      !Array.isArray(page.changes) ||
      typeof page.hasMore !== "boolean" ||
      (page.hasMore && page.changes.length === 0) ||
      !Number.isSafeInteger(page.cursor)
    )
      throw Error("同步分页无效");
    let cursor = state.cursor;
    for (const batch of page.changes) {
      if (
        !batch ||
        batch.cursor !== cursor + 1 ||
        typeof batch.operationId !== "string" ||
        typeof batch.deviceId !== "string"
      )
        throw Error("同步游标不连续");
      checkEntities(batch.entities);
      cursor = batch.cursor;
    }
    if (page.cursor !== cursor) throw Error("同步页游标无效");
    for (const batch of page.changes) await applyBatch(db, batch);
    await run(
      db,
      "UPDATE mobile_entity_sync_state SET cursor=?,last_success=?,generation=COALESCE(?,generation)",
      [cursor, new Date().toISOString(), page.generation ?? null],
    );
  });
}
export async function rejectEntities(db: Connection, error?: string) {
  return tx(db, async () => {
    if (error) {
      const pending = await one(
        db,
        "SELECT payload FROM mobile_entity_sync_pending",
      );
      if (pending)
        await run(
          db,
          "INSERT OR REPLACE INTO mobile_entity_sync_rejected VALUES(1,?,?)",
          [pending.payload, error],
        );
    }
    await run(db, "DELETE FROM mobile_entity_sync_pending");
  });
}
export async function repairRejected(
  db: Connection,
  command: import("./workspace").WorkspaceCommand,
) {
  const result = await changeWorkspace(db, command);
  await run(db, "DELETE FROM mobile_entity_sync_rejected");
  return result;
}
export async function resolveEntities(
  db: Connection,
  operationId: string,
  keepLocal: boolean,
  expected: string,
  resolutionId: string,
  merged?: WorkspaceEntity[],
) {
  return tx(db, async () => {
    if (
      await one(
        db,
        "SELECT operation_id FROM mobile_operations WHERE operation_id=?",
        [resolutionId],
      )
    )
      return;
    const state = await entityState(db);
    if (!state.active) throw Error("请切回配对工作空间");
    const record = await one(
      db,
      "SELECT payload FROM mobile_entity_sync_conflicts WHERE operation_id=?",
      [operationId],
    );
    if (
      !record ||
      state.conflicts.find((c) => c.operationId === operationId)?.expected !==
        expected
    )
      throw Error("冲突内容已变化，请刷新");
    const batch = JSON.parse(String(record.payload)) as EntityBatch;
    const current = await readWorkspace(db);
    const next = new Map(current.entities.map((e) => [e.id, e]));
    for (const e of batch.entities)
      if (!keepLocal || !next.has(e.id)) next.set(e.id, e);
    if (merged) {
      checkEntities(merged);
      if (
        merged.length !== batch.entities.length ||
        merged.some(
          (e) =>
            !batch.entities.some(
              (r) =>
                r.id === e.id &&
                r.kind === e.kind &&
                r.createdAt === e.createdAt,
            ),
        )
      )
        throw Error("合并条目身份无效");
      for (const e of merged) next.set(e.id, e);
    }
    validateGraph([...next.values()]);
    for (const e of batch.entities) {
      const old = current.entities.find((x) => x.id === e.id);
      if (!keepLocal || !old || merged) await write(db, next.get(e.id)!, old);
      await setShadow(db, e);
    }
    await history(db, resolutionId, {
      kind: "resolve_entity_conflict",
      keepLocal,
      merged,
      before: current.entities.filter((e) =>
        batch.entities.some((r) => r.id === e.id),
      ),
      remote: batch.entities,
    });
    await run(
      db,
      "DELETE FROM mobile_entity_sync_conflicts WHERE operation_id=?",
      [operationId],
    );
    await run(db, "DELETE FROM mobile_entity_sync_pending");
  });
}

export async function rebaseEntities(
  db: Connection,
  entities: WorkspaceEntity[],
  cursor: number,
  generation: string,
) {
  return tx(db, async () => {
    checkEntities(entities);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || !generation)
      throw Error("快照格式无效");
    const state = await entityState(db);
    if (!state.active) throw Error("请切回配对工作空间");
    const pending = await one(
      db,
      "SELECT payload FROM mobile_entity_sync_pending",
    );
    await history(db, crypto.randomUUID(), {
      kind: "entity_sync_rebase",
      previousGeneration: state.generation,
      generation,
      pending: pending?.payload ?? null,
      conflicts: state.conflicts,
    });
    await run(db, "DELETE FROM mobile_entity_sync_conflicts");
    const locals = (await readWorkspace(db)).entities;
    const baselines = (
      (await db.query("SELECT remote FROM mobile_entity_sync_shadow")).values ??
      []
    ).map((r) => JSON.parse(String(r.remote)) as WorkspaceEntity);
    const graph = [...locals, ...baselines, ...entities];
    const remaining = new Map(entities.map((e) => [e.id, e]));
    // The complete snapshot is staged above and commits with one cursor below.
    // Preserve atomic related graphs, while a collision in one independent
    // project must not freeze every other project after a server restart.
    while (remaining.size) {
      const seed = remaining.values().next().value as WorkspaceEntity;
      const ids = connectedIds(graph, [seed]);
      const component = [...remaining.values()].filter((e) => ids.has(e.id));
      for (const e of component) remaining.delete(e.id);
      await applyBatch(
        db,
        {
          entities: component,
          cursor,
          operationId: crypto.randomUUID(),
          deviceId: "snapshot",
        },
        undefined,
        true,
      );
    }
    const ids = new Set(entities.map((e) => e.id));
    for (const e of (await db.query("SELECT id FROM mobile_entity_sync_shadow"))
      .values ?? [])
      if (!ids.has(String(e.id)))
        await run(db, "DELETE FROM mobile_entity_sync_shadow WHERE id=?", [
          e.id,
        ]);
    await run(db, "DELETE FROM mobile_entity_sync_pending");
    await run(db, "DELETE FROM mobile_entity_sync_rejected");
    await run(
      db,
      "UPDATE mobile_entity_sync_state SET cursor=?,generation=?,last_success=?",
      [cursor, generation, new Date().toISOString()],
    );
  });
}
