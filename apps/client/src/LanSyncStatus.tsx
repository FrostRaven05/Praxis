import { feedbackMessage } from "./feedback-message";
import { useEffect, useRef, useState } from "react";
import { invoke, isTauri } from "./native-recovery";
import { TaskPanelIcon } from "./TaskPanelIcon";
import "./lan-sync.css";
type Status = {
  state?: string;
  message?: string;
  lastSuccess?: string;
  entityConflicts?: number;
  entityPending?: number;
  entityCursor?: number;
};
export type SyncedEntity = {
  id: string;
  kind: string;
  version: number;
  data: Record<string, unknown>;
  deleted: boolean;
  createdAt: string;
  updatedAt: string;
};
type Conflict = {
  operationId: string;
  local: SyncedEntity[];
  remote: SyncedEntity[];
  message: string;
  token: string;
};
type Resolution = {
  operationId: string;
  resolutionId: string;
  decision: "local" | "remote" | "merge";
  token: string;
  merged: SyncedEntity[] | null;
};
const kinds: Record<string, string> = {
  task: "任务",
  project: "项目",
  section: "分区",
  plan: "每日安排",
  capture: "收件箱",
  record: "记录",
  habit: "习惯",
  habit_check: "习惯记录",
  recurrence: "重复规则",
  review: "回顾",
  view: "保存视图",
  settings: "设置",
  strategy: "策略",
  decision: "决策",
  focus: "专注",
  desktop_row: "关联数据",
};
function EntityText({ entity }: { entity: SyncedEntity }) {
  return (
    <article>
      <strong>
        {kinds[entity.kind] ?? entity.kind} ·{" "}
        {String(entity.data.title ?? entity.data.rawText ?? entity.id)}
      </strong>
      <p>
        版本 {entity.version}
        {entity.deleted ? " · 已删除" : ""} ·{" "}
        {new Date(entity.updatedAt).toLocaleString()}
      </p>
      <pre>{JSON.stringify(entity.data, null, 2)}</pre>
    </article>
  );
}
export function LanSyncStatus({ onRefresh }: { onRefresh: () => void }) {
  const [status, setStatus] = useState<Status>({}),
    [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Resolution | null>(null),
    [open, setOpen] = useState(false);
  const [mergeDraft, setMergeDraft] = useState<Record<string, string>>({});
  const [mergeTokens, setMergeTokens] = useState<Record<string, string>>({});
  const trigger = useRef<HTMLButtonElement>(null);
  function close() {
    setOpen(false);
    trigger.current?.focus();
  }
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let last: string | undefined;
    const poll = async () => {
      try {
        const s = await invoke<Status>("lan_sync_status");
        const c = await invoke<Conflict[]>("lan_entity_conflicts");
        if (!active) return;
        setStatus(s);
        setConflicts(c);
        const revision = `${s.entityCursor ?? 0}:${s.lastSuccess ?? ""}`;
        if (s.lastSuccess && revision !== last) {
          last = revision;
          onRefresh();
        }
      } catch {
        if (active)
          setStatus({
            state: "offline",
            message: "同步状态暂不可用，本机操作不受影响",
          });
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 3000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [onRefresh]);
  async function submit(command: Resolution) {
    if (busy) return;
    setBusy(true);
    setError("");
    setPending(command);
    try {
      await invoke("lan_entity_resolve", command);
      setPending(null);
      await invoke<Conflict[]>("lan_entity_conflicts")
        .then(setConflicts)
        .catch(() => undefined);
      onRefresh();
    } catch (e) {
      const message = String(e);
      setError(message);
      if (/已变化|已更新|STALE|INVALID|CONFLICT_CHANGED/.test(message)) {
        setPending(null);
        await invoke<Conflict[]>("lan_entity_conflicts")
          .then(setConflicts)
          .catch(() => undefined);
      }
    } finally {
      setBusy(false);
    }
  }
  function resolve(c: Conflict, decision: Resolution["decision"]) {
    if (busy || pending) return;
    let merged: SyncedEntity[] | null = null;
    if (decision === "merge") {
      try {
        merged = JSON.parse(
          mergeDraft[c.operationId] ?? JSON.stringify(c.local),
        );
        if (!Array.isArray(merged)) throw Error();
      } catch {
        setError("合并内容不是有效 JSON 对象列表，请检查后重试。");
        return;
      }
    }
    if (
      !confirm(
        decision === "remote"
          ? "采用服务端这一批关联内容？本机版本会保存在同步历史。"
          : "将选择的内容作为这一批关联对象的新版本上传？双方旧版本会保存在同步历史。",
      )
    )
      return;
    void submit({
      operationId: c.operationId,
      resolutionId: crypto.randomUUID(),
      decision,
      token:
        decision === "merge"
          ? (mergeTokens[c.operationId] ?? c.token)
          : c.token,
      merged,
    });
  }
  const stateLabel =
    status.state === "online"
      ? "已连接"
      : status.state === "unpaired"
        ? "尚未配对"
        : status.state === "starting"
          ? "正在连接"
          : "离线";
  const pendingCount = status.entityPending ?? 0;
  const conflictCount = status.entityConflicts ?? 0;
  const statusLabel = `同步：${stateLabel}；待上传 ${pendingCount}；冲突 ${conflictCount}`;
  // The detail view only exists to resolve conflicts; otherwise the icon is a
  // plain status indicator and never opens a popup.
  const hasConflicts = conflictCount > 0 || conflicts.length > 0;
  const iconState = hasConflicts ? "conflict" : (status.state ?? "offline");
  const iconContent = (
    <>
      <TaskPanelIcon name="sync" />
      <span className="lan-sync-indicator" aria-hidden="true" />
    </>
  );
  return (
    <aside className="lan-sync" aria-label="局域网同步">
      {hasConflicts ? (
        <button
          data-testid="lan-sync-status"
          ref={trigger}
          className="lan-sync-icon"
          data-state={iconState}
          title={`${statusLabel}，点击处理冲突`}
          aria-label={statusLabel}
          aria-haspopup="dialog"
          aria-controls="lan-sync-detail"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
        >
          {iconContent}
        </button>
      ) : (
        <span
          data-testid="lan-sync-status"
          className="lan-sync-icon"
          role="img"
          data-state={iconState}
          title={statusLabel}
          aria-label={statusLabel}
        >
          {iconContent}
        </span>
      )}
      {open && hasConflicts && (
        <section
          id="lan-sync-detail"
          className="lan-sync-detail"
          role="dialog"
          aria-label="工作空间同步"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              close();
            }
          }}
        >
          <button className="lan-sync-close" autoFocus onClick={close}>
            关闭同步详情
          </button>
          <h2>工作空间同步</h2>
          <p role="status">
            {stateLabel} · 待上传 {pendingCount} · 冲突 {conflictCount}
          </p>
          <p>
            任务、项目、安排、记录、习惯等内容自动同步。修改先保存在本机，连接恢复后继续上传。
          </p>
          <p>
            最近成功：
            {status.lastSuccess
              ? new Date(status.lastSuccess).toLocaleString()
              : "尚未同步"}
          </p>
          {status.message && <p role="status">{status.message}</p>}
          {error && <p role="alert">{feedbackMessage(error)}</p>}
          {pending && (
            <button disabled={busy} onClick={() => void submit(pending)}>
              重试冲突处理
            </button>
          )}
          {conflicts.map((c) => (
            <details key={c.operationId} data-testid="entity-sync-conflict">
              <summary>{c.local.length} 项关联内容同步冲突</summary>
              <p>{c.message}</p>
              <div className="lan-sync-versions">
                <section>
                  <h3>本机版本</h3>
                  {c.local.map((e) => (
                    <EntityText key={e.id} entity={e} />
                  ))}
                </section>
                <section>
                  <h3>服务端版本</h3>
                  {c.remote.map((e) => (
                    <EntityText key={e.id} entity={e} />
                  ))}
                </section>
              </div>
              <button
                disabled={busy || !!pending}
                onClick={() => resolve(c, "local")}
              >
                保留本机内容
              </button>
              <button
                disabled={busy || !!pending}
                onClick={() => resolve(c, "remote")}
              >
                采用服务端
              </button>
              <details>
                <summary>手动合并字段</summary>
                <button
                  disabled={busy || !!pending}
                  onClick={() => {
                    setMergeDraft((d) => ({
                      ...d,
                      [c.operationId]: JSON.stringify(c.local, null, 2),
                    }));
                    setMergeTokens((t) => ({ ...t, [c.operationId]: c.token }));
                  }}
                >
                  载入最新本机版本重新编辑
                </button>
                <p>
                  编辑对象的 data
                  字段，保留对象标识；保存时会重新校验版本和关联。
                </p>
                <textarea
                  aria-label="合并后的内容"
                  rows={14}
                  value={
                    mergeDraft[c.operationId] ??
                    JSON.stringify(c.local, null, 2)
                  }
                  onChange={(e) => {
                    setMergeTokens((tokens) => ({
                      ...tokens,
                      [c.operationId]: tokens[c.operationId] ?? c.token,
                    }));
                    setMergeDraft({
                      ...mergeDraft,
                      [c.operationId]: e.target.value,
                    });
                  }}
                />
                <button
                  disabled={busy || !!pending}
                  onClick={() => resolve(c, "merge")}
                >
                  保存合并
                </button>
              </details>
            </details>
          ))}
        </section>
      )}
    </aside>
  );
}
