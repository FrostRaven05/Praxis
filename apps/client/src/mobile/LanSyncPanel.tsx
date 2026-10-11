import { useEffect, useRef, useState } from "react";
import { registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { mobileStorage } from "../../../../packages/storage-mobile/src/native";
import {
  WorkspaceRejectedError,
  type EntityCommand,
  type EntityPage,
  type WorkspaceEntity,
  type WorkspaceCommand,
} from "@praxis/storage-mobile";
const native = registerPlugin<{
  status(): Promise<{
    configured: boolean;
    baseUrl: string;
    ownerId: string;
    deviceId: string;
  }>;
  request(options: {
    method: string;
    path: string;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }>;
}>("LanSync");
type State = Awaited<ReturnType<typeof mobileStorage.entityState>>;
export function LanSyncPanel({ refresh }: { refresh: () => Promise<void> }) {
  const [message, setMessage] = useState("正在检查局域网配对"),
    [state, setState] = useState<State | null>(null),
    [expanded, setExpanded] = useState(false);
  const busy = useRef(false),
    refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const resolution = useRef<Parameters<
    typeof mobileStorage.entityResolve
  > | null>(null);
  const [pending, setPending] = useState(false);
  const [mergeDrafts, setMergeDrafts] = useState<Record<string, string>>({});
  const [repairDraft, setRepairDraft] = useState("");
  const repairBase = useRef<WorkspaceEntity[] | null>(null);
  const mergeBases = useRef<Record<string, string>>({});
  const repairPending = useRef<WorkspaceCommand | null>(null);
  async function snapshot() {
    let all: WorkspaceEntity[] = [],
      cursor: number | undefined,
      generation = "",
      afterId = "";
    for (let i = 0; i < 1000; i++) {
      const suffix =
        cursor === undefined
          ? ""
          : `&at=${cursor}&afterId=${afterId}&generation=${generation}`;
      const r = await native.request({
        method: "GET",
        path: `/v1/entities/snapshot?limit=100${suffix}`,
      });
      if (r.status !== 200) throw Error(`快照读取失败 ${r.status}`);
      const page = r.body as {
        entities: WorkspaceEntity[];
        cursor: number;
        generation: string;
        hasMore: boolean;
        nextId: string;
      };
      if (
        cursor !== undefined &&
        (cursor !== page.cursor || generation !== page.generation)
      )
        throw Error("快照已变化，请重试");
      cursor = page.cursor;
      generation = page.generation;
      all.push(...page.entities);
      if (!page.hasMore) {
        await mobileStorage.entityRebase(all, cursor, generation);
        return;
      }
      if (!page.nextId || page.nextId === afterId) throw Error("快照分页无效");
      afterId = page.nextId;
    }
    throw Error("快照超出支持范围");
  }
  async function pull() {
    for (let i = 0; i < 50; i++) {
      const current = await mobileStorage.entityState();
      const r = await native.request({
        method: "GET",
        path: `/v1/entities/changes?after=${current.cursor}&limit=25`,
      });
      if (
        r.status === 400 &&
        (r.body as { error?: string }).error === "INVALID_CURSOR"
      ) {
        await snapshot();
        continue;
      }
      if (r.status !== 200) throw Error(`服务返回 ${r.status}`);
      const page = r.body as EntityPage;
      if (!current.generation || page.generation !== current.generation) {
        await snapshot();
        continue;
      }
      await mobileStorage.entityPull(page);
      if (!page.hasMore) return;
    }
    throw Error("同步积压较多，将继续读取");
  }
  async function sync() {
    if (busy.current || document.visibilityState === "hidden") return;
    busy.current = true;
    try {
      const config = await native.status();
      if (!config.configured) {
        setMessage("局域网未配对");
        return;
      }
      await mobileStorage.lanBind({ ...config, workspaceId: "local" });
      let current = await mobileStorage.entityState();
      setState(current);
      if (!current.active) {
        setMessage("当前工作空间未接入同步");
        return;
      }
      setMessage("正在同步工作空间");
      await pull();
      for (let i = 0; i < 10; i++) {
        const command = await mobileStorage.entityPrepare();
        if (!command) break;
        const r = await native.request({
          method: "POST",
          path: `/v1/entities/commands?generation=${(await mobileStorage.entityState()).generation}`,
          body: command,
        });
        if (r.status === 409) {
          const code = (r.body as { error?: string }).error ?? "CONFLICT";
          if (code === "GENERATION_CHANGED") {
            await snapshot();
            continue;
          }
          await mobileStorage.entityReject(
            code === "INVALID_GRAPH" ? code : undefined,
          );
          await pull();
          throw Error("远端内容或关联已变化，已保留本机内容，请处理冲突后重试");
        }
        if (r.status !== 200) throw Error(`服务返回 ${r.status}`);
        await mobileStorage.entityAck(
          command,
          (r.body as { entities: WorkspaceEntity[] }).entities,
        );
      }
      await pull();
      current = await mobileStorage.entityState();
      setState(current);
      setMessage(
        current.rejected
          ? "有一批内容未通过关联校验，请展开同步面板修复"
          : current.conflicts.length
            ? `${current.conflicts.length} 批内容冲突待处理`
            : "工作空间自动同步已运行",
      );
      await refreshRef.current();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "同步失败，稍后自动重试");
      setState(await mobileStorage.entityState().catch(() => null));
    } finally {
      busy.current = false;
    }
  }
  useEffect(() => {
    void sync();
    const timer = setInterval(() => void sync(), 5000);
    const resume = () => void sync();
    window.addEventListener("online", resume);
    document.addEventListener("visibilitychange", resume);
    const listener = App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void sync();
    });
    return () => {
      clearInterval(timer);
      window.removeEventListener("online", resume);
      document.removeEventListener("visibilitychange", resume);
      void listener.then((h) => h.remove());
    };
  }, []);
  async function retry() {
    const args = resolution.current;
    if (!args) return;
    try {
      await mobileStorage.entityResolve(...args);
      resolution.current = null;
      setPending(false);
      await sync();
    } catch (e) {
      setMessage(String(e));
      if (
        e instanceof WorkspaceRejectedError ||
        (e instanceof Error && /已变化|请切回|无效/.test(e.message))
      ) {
        resolution.current = null;
        setPending(false);
      }
    }
  }
  function resolve(c: NonNullable<State>["conflicts"][number], keep: boolean) {
    if (
      resolution.current ||
      !confirm(
        keep
          ? "保留本机这一批内容，并基于远端版本重新上传？远端版本将留在同步活动历史。"
          : "采用远端这一批内容？本机版本将留在同步活动历史。",
      )
    )
      return;
    resolution.current = [c.operationId, keep, c.expected, crypto.randomUUID()];
    setPending(true);
    void retry();
  }
  function mergeConflict(c: NonNullable<State>["conflicts"][number]) {
    if (resolution.current) return;
    try {
      const entities = JSON.parse(
        mergeDrafts[c.operationId] ?? JSON.stringify(c.batch.entities),
      ) as WorkspaceEntity[];
      resolution.current = [
        c.operationId,
        true,
        mergeBases.current[c.operationId] ?? c.expected,
        crypto.randomUUID(),
        entities,
      ];
      setPending(true);
      void retry();
    } catch {
      setMessage("合并内容不是有效 JSON，请检查后重试");
    }
  }
  async function repair() {
    try {
      if (!repairPending.current) {
        const changes = (
          JSON.parse(
            repairDraft || String(state?.rejected?.payload),
          ) as EntityCommand
        ).changes;
        const entities = repairBase.current ?? state?.rejectedLocal ?? [];
        repairPending.current = {
          operationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          changes: changes.map((c) => {
            const e = entities.find((x) => x.id === c.id);
            if (!e || e.kind !== c.kind) throw Error("修复条目身份无效");
            return {
              id: e.id,
              kind: e.kind,
              expectedVersion: e.version,
              data: c.data,
              deleted: c.deleted,
            };
          }),
        };
      }
      await mobileStorage.entityRepair(repairPending.current);
      repairPending.current = null;
      repairBase.current = null;
      setRepairDraft("");
      await sync();
    } catch (e) {
      setMessage(String(e));
      if (e instanceof WorkspaceRejectedError) repairPending.current = null;
    }
  }
  return (
    <aside className="pm-lan-sync">
      <button
        data-testid="lan-sync-status"
        onClick={() => setExpanded(!expanded)}
      >
        {message}
      </button>
      <button data-testid="lan-sync-now" onClick={() => void sync()}>
        同步
      </button>
      {pending && <button onClick={() => void retry()}>重试冲突处理</button>}
      {expanded && (
        <div>
          {state?.rejected && (
            <div>
              <p>
                关联校验失败，本机数据已保留。可返回相应页面修改，或在下面修复这一批内容；不得更改编号和类型。
              </p>
              <textarea
                aria-label="修复同步内容"
                value={repairDraft || String(state.rejected.payload)}
                onChange={(e) => {
                  repairBase.current ??= state.rejectedLocal;
                  setRepairDraft(e.target.value);
                }}
              />
              <button onClick={() => void repair()}>保存修复并重试</button>
            </div>
          )}
          <p>
            自动同步任务、项目、安排、收件箱及其他工作空间内容。AI
            功能保持搁置。
          </p>
          <p>
            最近成功：
            {state?.lastSuccess
              ? new Date(state.lastSuccess).toLocaleString()
              : "尚未同步"}
          </p>
          {state?.conflicts.map((c) => (
            <div key={c.operationId} data-testid="entity-sync-conflict">
              <p>{c.batch.entities.length} 项关联内容存在冲突</p>
              <p>本机版本</p>
              <pre>{JSON.stringify(c.local, null, 2)}</pre>
              <p>远端版本</p>
              <pre>
                {JSON.stringify(
                  c.batch.entities.map((e) => ({
                    kind: e.kind,
                    data: e.data,
                    deleted: e.deleted,
                  })),
                  null,
                  2,
                )}
              </pre>
              <button onClick={() => resolve(c, true)}>保留本机版本</button>
              <button onClick={() => resolve(c, false)}>采用服务端</button>
              <details>
                <summary>逐项编辑合并内容</summary>
                <p>
                  编辑 data 与 deleted
                  保留双方需要的字段；条目编号、类型及创建时间保持不变。
                </p>
                <textarea
                  aria-label="合并冲突内容"
                  value={
                    mergeDrafts[c.operationId] ??
                    JSON.stringify(c.batch.entities, null, 2)
                  }
                  onChange={(e) => {
                    mergeBases.current[c.operationId] ??= c.expected;
                    setMergeDrafts({
                      ...mergeDrafts,
                      [c.operationId]: e.target.value,
                    });
                  }}
                />
                <button onClick={() => mergeConflict(c)}>保存合并版本</button>
              </details>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
