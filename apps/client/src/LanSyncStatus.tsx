import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
type Status = {
  state?: string;
  message?: string;
  lastSuccess?: string;
  conflictCount?: number;
  pendingCount?: number;
};
type Conflict = {
  id: string;
  localText: string;
  remote: { rawText: string; version: number; deleted: boolean } | null;
};
type Resolution = {
  operationId: string;
  id: string;
  remoteVersion: number;
  localText: string;
  keepCopy: boolean;
};
export function LanSyncStatus({ onRefresh }: { onRefresh: () => void }) {
  const [status, setStatus] = useState<Status>({});
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Resolution | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let active = true;
    let last: string | undefined;
    const poll = async () => {
      try {
        const s = await invoke<Status>("lan_sync_status");
        const c = await invoke<Conflict[]>("lan_sync_conflicts");
        if (!active) return;
        setStatus(s);
        setConflicts(c);
        if (s.lastSuccess && s.lastSuccess !== last) {
          last = s.lastSuccess;
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
    const timer = setInterval(() => void poll(), 5000);
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
      await invoke("lan_sync_resolve", command);
      setPending(null);
      setConflicts(await invoke<Conflict[]>("lan_sync_conflicts"));
      onRefresh();
    } catch (e) {
      const message = String(e);
      setError(message);
      if (
        message === "冲突内容已更新，请刷新后再次选择" ||
        message === "请等待服务端冲突版本到达"
      ) {
        setPending(null);
        setConflicts(await invoke<Conflict[]>("lan_sync_conflicts"));
      }
    } finally {
      setBusy(false);
    }
  }
  async function resolve(c: Conflict, keepCopy: boolean) {
    if (!c.remote || busy || pending) return;
    if (
      !window.confirm(
        keepCopy
          ? "保留本机文字为新的收集项，并将原项更新为服务端版本？"
          : "将此收集项更新为服务端版本？本机旧文字保存在操作记录中。",
      )
    )
      return;
    await submit({
      operationId: crypto.randomUUID(),
      id: c.id,
      remoteVersion: c.remote.version,
      localText: c.localText,
      keepCopy,
    });
  }
  return (
    <aside data-testid="lan-sync-status" aria-label="局域网同步">
      <p role="status">
        局域网：
        {status.state === "online"
          ? "已连接"
          : status.state === "unpaired"
            ? "尚未配对"
            : status.state === "starting"
              ? "正在连接"
              : "离线"}{" "}
        · 待上传 {status.pendingCount ?? 0} · 冲突 {status.conflictCount ?? 0}
        {status.lastSuccess
          ? ` · 最近成功 ${new Date(status.lastSuccess).toLocaleTimeString()}`
          : ""}
      </p>
      {status.message && <p>{status.message}</p>}
      <small>
        自动同步收集项原文及删除状态。澄清结果、任务和项目暂仅保存在本机。冲突保留双方内容，不会自动覆盖。
      </small>
      {error && <p role="alert">{error}</p>}
      {pending && (
        <button disabled={busy} onClick={() => void submit(pending)}>
          重试冲突处理
        </button>
      )}
      {conflicts.map((c) => (
        <details key={c.id} data-testid="lan-conflict">
          <summary>收集项同步冲突</summary>
          <p>本机版本</p>
          <pre>{c.localText}</pre>
          <p>服务端版本{c.remote?.deleted ? "（已删除）" : ""}</p>
          <pre>{c.remote?.rawText ?? "等待拉取服务端版本…"}</pre>
          <button
            disabled={busy || !!pending || !c.remote}
            onClick={() => void resolve(c, false)}
          >
            采用服务端
          </button>
          <button
            disabled={busy || !!pending || !c.remote}
            onClick={() => void resolve(c, true)}
          >
            保留本机为新收集项
          </button>
        </details>
      ))}
    </aside>
  );
}
