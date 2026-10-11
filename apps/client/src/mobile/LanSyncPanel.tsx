import { useEffect, useRef, useState } from "react";
import { registerPlugin } from "@capacitor/core";
import { App } from "@capacitor/app";
import { mobileStorage } from "../../../../packages/storage-mobile/src/native";
import type { LanCapture, LanPage } from "@praxis/storage-mobile";
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
type State = Awaited<ReturnType<typeof mobileStorage.lanState>>;
export function LanSyncPanel({ refresh }: { refresh: () => Promise<void> }) {
  const [message, setMessage] = useState("正在检查局域网配对"),
    [state, setState] = useState<State | null>(null),
    [expanded, setExpanded] = useState(false);
  const resolution = useRef<Parameters<typeof mobileStorage.lanResolve> | null>(
    null,
  );
  const [pendingResolution, setPendingResolution] = useState(false);
  const busy = useRef(false),
    refreshRef = useRef(refresh);
  refreshRef.current = refresh;
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
      let current = await mobileStorage.lanState();
      setState(current);
      if (!current.active) {
        setMessage("当前工作空间未接入同步");
        return;
      }
      setMessage("正在同步收件箱");
      for (let i = 0; i < 50; i++) {
        const command = await mobileStorage.lanPrepare();
        if (!command) break;
        const result = await native.request({
          method: "POST",
          path: "/v1/captures/commands",
          body: command,
        });
        if (result.status === 409) {
          await mobileStorage.lanBlock(command.id);
          continue;
        }
        if (result.status !== 200) throw Error(`服务返回 ${result.status}`);
        await mobileStorage.lanAck(
          command,
          (result.body as { capture: LanCapture }).capture,
        );
      }
      for (let i = 0; i < 50; i++) {
        current = await mobileStorage.lanState();
        const result = await native.request({
          method: "GET",
          path: `/v1/captures/changes?after=${current.cursor}&limit=25`,
        });
        if (result.status !== 200) throw Error(`服务返回 ${result.status}`);
        const page = result.body as LanPage;
        await mobileStorage.lanPull(page);
        if (!page.hasMore) break;
      }
      current = await mobileStorage.lanState();
      setState(current);
      setMessage(
        current.conflicts.length
          ? `${current.conflicts.length} 项原文冲突待处理`
          : "收件箱同步已运行",
      );
      await refreshRef.current();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "同步失败，下次联网自动重试");
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
  async function resolve(c: Record<string, unknown>, keep: boolean) {
    if (
      !confirm(
        keep
          ? "保留本机原文为新的收集项，再接受服务端版本？"
          : "接受服务端原文及删除状态？本机原文将被替换。",
      )
    )
      return;
    if (resolution.current) return;
    resolution.current = [
      String(c.id),
      keep,
      Number(c.local_version),
      Number(c.remote ? JSON.parse(String(c.remote)).version : 0),
      crypto.randomUUID(),
    ];
    setPendingResolution(true);
    await retryResolution();
  }
  async function retryResolution() {
    const command = resolution.current;
    if (!command) return;
    try {
      await mobileStorage.lanResolve(...command);
      resolution.current = null;
      setPendingResolution(false);
      await sync();
    } catch (e) {
      setMessage(String(e));
      if (
        e instanceof Error &&
        /内容已变化|尚未取得|请切回|条目不存在/.test(e.message)
      ) {
        resolution.current = null;
        setPendingResolution(false);
      }
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
      {pendingResolution && (
        <button onClick={() => void retryResolution()}>重试冲突处理</button>
      )}
      {expanded && (
        <div>
          <p>仅同步收件箱原文和删除状态。任务、项目及澄清状态保留本机。</p>
          <p>
            最近成功：
            {state?.lastSuccess
              ? new Date(state.lastSuccess).toLocaleString()
              : "尚未同步"}
          </p>
          {state?.conflicts.map((c) => (
            <div key={String(c.id)}>
              <p>冲突收集项 {String(c.id)}</p>
              <p>本机原文</p>
              <pre>
                {c.local_data
                  ? JSON.parse(String(c.local_data)).rawText
                  : "本机条目不存在"}
              </pre>
              <p>服务端原文</p>
              <pre>
                {c.remote
                  ? JSON.parse(String(c.remote)).rawText
                  : "等待读取远端版本"}
              </pre>
              <button onClick={() => void resolve(c, true)}>
                保留本机为新收集项
              </button>
              <button onClick={() => void resolve(c, false)}>采用服务端</button>
            </div>
          ))}
        </div>
      )}
    </aside>
  );
}
