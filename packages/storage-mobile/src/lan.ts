import type { Connection } from "./index";
export interface LanBinding {
  baseUrl: string;
  ownerId: string;
  deviceId: string;
  workspaceId: string;
}
export interface LanCapture {
  id: string;
  version: number;
  rawText: string;
  deleted: boolean;
  updatedAt: string;
}
export interface LanCommand {
  operationId: string;
  deviceId: string;
  id: string;
  expectedVersion: number | null;
  rawText: string;
  deleted: boolean;
}
export interface LanPage {
  changes: { capture: LanCapture; cursor: number }[];
  cursor: number;
  hasMore: boolean;
}
// CapacitorSQLite defaults run() to an implicit transaction; explicit transactions own all LAN writes.
const run = (db: Connection, sql: string, values: unknown[] = []) =>
  db.run(sql, values, false);
const row = async (db: Connection, sql: string, args: unknown[] = []) =>
  (await db.query(sql, args)).values?.[0];
async function transaction<T>(db: Connection, f: () => Promise<T>): Promise<T> {
  await db.beginTransaction();
  try {
    const value = await f();
    await db.commitTransaction();
    return value;
  } catch (e) {
    await db.rollbackTransaction().catch(() => undefined);
    throw e;
  }
}
export async function bindLan(db: Connection, b: LanBinding) {
  const prior = await row(
    db,
    "SELECT * FROM mobile_lan_binding WHERE singleton=1",
  );
  if (prior) {
    if (
      prior.base_url !== b.baseUrl ||
      prior.owner_id !== b.ownerId ||
      prior.device_id !== b.deviceId
    )
      throw Error("配对身份已变化，需要显式迁移工作空间。");
    return;
  }
  if (
    !(await row(db, "SELECT id FROM mobile_workspaces WHERE id=?", [
      b.workspaceId,
    ]))
  )
    throw Error("工作空间不存在");
  await run(db, "INSERT INTO mobile_lan_binding VALUES(1,?,?,?,?,0,NULL)", [
    b.workspaceId,
    b.baseUrl,
    b.ownerId,
    b.deviceId,
  ]);
}
export async function lanState(db: Connection) {
  const b = await row(db, "SELECT * FROM mobile_lan_binding WHERE singleton=1");
  const active = await row(
    db,
    "SELECT id FROM mobile_workspaces WHERE active=1",
  );
  const conflicts =
    (
      await db.query(
        "SELECT s.id,s.remote,e.data AS local_data,e.version AS local_version FROM mobile_lan_shadow s LEFT JOIN mobile_entities e ON e.id=s.id AND e.workspace_id=(SELECT workspace_id FROM mobile_lan_binding WHERE singleton=1) WHERE s.conflict=1",
      )
    ).values ?? [];
  return {
    binding: b,
    active: !!b && b.workspace_id === active?.id,
    conflicts,
    cursor: Number(b?.cursor ?? 0),
    lastSuccess: b?.last_success ? String(b.last_success) : null,
  };
}
export async function prepareLan(db: Connection): Promise<LanCommand | null> {
  return transaction(db, async () => {
    const state = await lanState(db);
    if (!state.active) return null;
    const pending = await row(
      db,
      "SELECT payload FROM mobile_lan_pending WHERE blocked=0 ORDER BY rowid LIMIT 1",
    );
    if (pending) return JSON.parse(String(pending.payload));
    const rows =
      (
        await db.query(
          "SELECT e.*,s.remote,s.conflict,p.id AS pending_id FROM mobile_entities e LEFT JOIN mobile_lan_shadow s ON s.id=e.id LEFT JOIN mobile_lan_pending p ON p.id=e.id WHERE workspace_id=? AND kind='capture'",
          [state.binding!.workspace_id],
        )
      ).values ?? [];
    for (const e of rows) {
      if (e.conflict || e.pending_id) continue;
      const data = JSON.parse(String(e.data));
      const old = e.remote
        ? (JSON.parse(String(e.remote)) as LanCapture)
        : null;
      if (!old && e.deleted) continue;
      if (old && old.rawText === data.rawText && old.deleted === !!e.deleted)
        continue;
      const command: LanCommand = {
        operationId: crypto.randomUUID(),
        deviceId: String(state.binding!.device_id),
        id: String(e.id),
        expectedVersion: old?.version ?? null,
        rawText: data.rawText,
        deleted: !!e.deleted,
      };
      await run(
        db,
        "INSERT INTO mobile_lan_pending(id,payload,blocked) VALUES(?,?,0)",
        [e.id, JSON.stringify(command)],
      );
      return command;
    }
    return null;
  });
}
export async function ackLan(
  db: Connection,
  command: LanCommand,
  capture: LanCapture,
) {
  return transaction(db, async () => {
    const pending = await row(
      db,
      "SELECT payload FROM mobile_lan_pending WHERE id=?",
      [command.id],
    );
    if (!pending) return;
    if (String(pending.payload) !== JSON.stringify(command))
      throw Error("确认操作不匹配");
    await run(
      db,
      "INSERT INTO mobile_lan_shadow(id,remote,conflict) VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET remote=excluded.remote,conflict=0",
      [capture.id, JSON.stringify(capture)],
    );
    await run(db, "DELETE FROM mobile_lan_pending WHERE id=?", [command.id]);
  });
}
export async function blockLan(db: Connection, id: string) {
  return transaction(db, async () => {
    await run(db, "UPDATE mobile_lan_pending SET blocked=1 WHERE id=?", [id]);
    await run(
      db,
      "INSERT INTO mobile_lan_shadow(id,remote,conflict) VALUES(?,NULL,1) ON CONFLICT(id) DO UPDATE SET conflict=1",
      [id],
    );
  });
}
export async function pullLan(db: Connection, page: LanPage) {
  return transaction(db, async () => {
    const state = await lanState(db);
    if (!state.binding) throw Error("未配对");
    if (page.cursor < state.cursor) throw Error("同步游标倒退");
    if (
      !Array.isArray(page.changes) ||
      page.changes.length > 25 ||
      !Number.isSafeInteger(page.cursor) ||
      typeof page.hasMore !== "boolean"
    )
      throw Error("无效同步页面");
    let priorCursor = state.cursor;
    for (const entry of page.changes) {
      const c = entry?.capture;
      if (
        !c ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          c.id,
        ) ||
        !Number.isSafeInteger(c.version) ||
        c.version < 1 ||
        typeof c.rawText !== "string" ||
        !c.rawText.trim() ||
        Array.from(c.rawText).length > 100000 ||
        typeof c.deleted !== "boolean" ||
        typeof c.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(c.updatedAt)) ||
        !Number.isSafeInteger(entry.cursor) ||
        entry.cursor <= priorCursor
      )
        throw Error("无效同步条目");
      priorCursor = entry.cursor;
    }
    if (
      page.cursor !== priorCursor ||
      (page.hasMore && page.changes.length === 0)
    )
      throw Error("无效同步游标");
    for (const { capture: c } of page.changes) {
      const old = await row(db, "SELECT * FROM mobile_lan_shadow WHERE id=?", [
        c.id,
      ]);
      const previous = old?.remote
        ? (JSON.parse(String(old.remote)) as LanCapture)
        : null;
      if (previous && previous.version >= c.version) continue;
      const local = await row(
        db,
        "SELECT * FROM mobile_entities WHERE workspace_id=? AND id=?",
        [state.binding.workspace_id, c.id],
      );
      if (local && local.kind !== "capture")
        throw Error("远端条目与本机类型冲突");
      const data = local ? JSON.parse(String(local.data)) : null;
      const pending = await row(
        db,
        "SELECT * FROM mobile_lan_pending WHERE id=?",
        [c.id],
      );
      const dirty =
        !!local &&
        (!previous ||
          data.rawText !== previous.rawText ||
          !!local.deleted !== previous.deleted);
      const same =
        !!local && data.rawText === c.rawText && !!local.deleted === c.deleted;
      const conflict = !!old?.conflict || !!pending || (dirty && !same);
      if (!conflict) {
        await run(db, "INSERT INTO mobile_operations VALUES(?,?,?,?)", [
          crypto.randomUUID(),
          state.binding.workspace_id,
          JSON.stringify({
            kind: "sync_capture_pull",
            id: c.id,
            before: local
              ? { data, deleted: !!local.deleted, version: local.version }
              : null,
            after: {
              data: { ...(data ?? { status: "inbox" }), rawText: c.rawText },
              deleted: c.deleted,
              version: local ? Number(local.version) + 1 : 1,
            },
            remote: c,
          }),
          new Date().toISOString(),
        ]);
        if (local) {
          await run(
            db,
            "UPDATE mobile_entities SET data=?,deleted=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=?",
            [
              JSON.stringify({ ...data, rawText: c.rawText }),
              Number(c.deleted),
              c.updatedAt,
              state.binding.workspace_id,
              c.id,
            ],
          );
        } else {
          await run(
            db,
            "INSERT INTO mobile_entities VALUES(?,?,'capture',1,?,?,?,?)",
            [
              state.binding.workspace_id,
              c.id,
              JSON.stringify({ rawText: c.rawText, status: "inbox" }),
              Number(c.deleted),
              c.updatedAt,
              c.updatedAt,
            ],
          );
        }
      }
      await run(
        db,
        "INSERT INTO mobile_lan_shadow(id,remote,conflict) VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET remote=excluded.remote,conflict=excluded.conflict",
        [c.id, JSON.stringify(c), Number(conflict)],
      );
      if (conflict)
        await run(db, "UPDATE mobile_lan_pending SET blocked=1 WHERE id=?", [
          c.id,
        ]);
    }
    await run(
      db,
      "UPDATE mobile_lan_binding SET cursor=?,last_success=? WHERE singleton=1",
      [page.cursor, new Date().toISOString()],
    );
  });
}
export async function resolveLan(
  db: Connection,
  id: string,
  keep: boolean,
  expectedLocalVersion: number,
  expectedRemoteVersion: number,
  operationId: string,
) {
  return transaction(db, async () => {
    const state = await lanState(db);
    if (!state.active) throw Error("请切回已配对工作空间");
    const request = { id, keep, expectedLocalVersion, expectedRemoteVersion };
    const receipt = await row(
      db,
      "SELECT payload FROM mobile_operations WHERE operation_id=? AND workspace_id=?",
      [operationId, state.binding!.workspace_id],
    );
    if (receipt) {
      if (
        JSON.stringify(JSON.parse(String(receipt.payload)).request) !==
        JSON.stringify(request)
      )
        throw Error("冲突处理操作标识已被使用");
      return;
    }
    const shadow = await row(
      db,
      "SELECT remote,conflict FROM mobile_lan_shadow WHERE id=?",
      [id],
    );
    if (!shadow?.conflict || !shadow.remote)
      throw Error("尚未取得服务端版本，请重试同步");
    const remote = JSON.parse(String(shadow.remote)) as LanCapture;
    const local = await row(
      db,
      "SELECT * FROM mobile_entities WHERE workspace_id=? AND id=?",
      [state.binding!.workspace_id, id],
    );
    if (!local) throw Error("本机条目不存在");
    if (
      Number(local.version) !== expectedLocalVersion ||
      remote.version !== expectedRemoteVersion
    )
      throw Error("冲突内容已变化，请刷新后重新选择");
    const data = JSON.parse(String(local.data));
    await run(db, "INSERT INTO mobile_operations VALUES(?,?,?,?)", [
      operationId,
      state.binding!.workspace_id,
      JSON.stringify({
        kind: "resolve_lan_conflict",
        request,
        id,
        keepLocalCopy: keep,
        local: data,
        remote,
      }),
      new Date().toISOString(),
    ]);
    if (keep) {
      await run(
        db,
        "INSERT INTO mobile_entities VALUES(?,?,'capture',1,?,0,?,?)",
        [
          state.binding!.workspace_id,
          crypto.randomUUID(),
          JSON.stringify({ rawText: data.rawText, status: "inbox" }),
          new Date().toISOString(),
          new Date().toISOString(),
        ],
      );
    }
    await run(
      db,
      "UPDATE mobile_entities SET data=?,deleted=?,version=version+1,updated_at=? WHERE workspace_id=? AND id=?",
      [
        JSON.stringify({ ...data, rawText: remote.rawText }),
        Number(remote.deleted),
        remote.updatedAt,
        state.binding!.workspace_id,
        id,
      ],
    );
    await run(db, "DELETE FROM mobile_lan_pending WHERE id=?", [id]);
    await run(db, "UPDATE mobile_lan_shadow SET conflict=0 WHERE id=?", [id]);
  });
}
