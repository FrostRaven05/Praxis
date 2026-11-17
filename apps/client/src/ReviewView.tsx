import { feedbackMessage } from "./feedback-message";
import { useLanRefresh } from "./useLanRefresh";
import { useEffect, useRef, useState } from "react";
import { invoke } from "./native-recovery";
import { RetriableCommands } from "../../../packages/application/src/retriable-commands";
import "./reviews.css";

type Review = {
  id: string;
  version: number;
  start: string;
  end: string;
  achievements: string;
  blockers: string;
  stopPause: string;
  nextFocus: string;
  projectIds: string[];
};
type Draft = Omit<Review, "version"> & { version: number | null };
type Snapshot = {
  today: string;
  timeZone: string;
  settings: { staleDays: number; version: number | null };
  projects: { id: string; name: string; archived: boolean }[];
  checks: {
    id: string;
    name: string;
    reasons: string[];
    lastProgressAt: string | null;
  }[];
  reviews: Review[];
};
type Command = {
  operationId: string;
  occurredAt: string;
  action: Record<string, unknown>;
};
const retries = new RetriableCommands<Command>();
function openProject(id: string) {
  window.dispatchEvent(new CustomEvent("praxis-work-project", { detail: id }));
}
export function ReviewView({
  onBusyChange,
  initialReviewId,
}: {
  onBusyChange?: (busy: boolean) => void;
  initialReviewId?: string | null;
}) {
  const [data, setData] = useState<Snapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [days, setDays] = useState(7),
    [draft, setDraft] = useState<Draft | null>(null),
    [dirty, setDirty] = useState(false);
  const lock = useRef(false);
  useLanRefresh(
    () => invoke<Snapshot>("review_snapshot"),
    (next) => {
      setData(next);
      setDays(next.settings.staleDays);
    },
    busy || dirty || draft !== null || days !== (data?.settings.staleDays ?? 7),
  );
  const opened = useRef<string | null>(null);
  useEffect(() => {
    if (!initialReviewId || !data || opened.current === initialReviewId) return;
    const found = data.reviews.find((r) => r.id === initialReviewId);
    if (found) {
      setDraft(found);
      opened.current = initialReviewId;
    } else {
      setError("这份回顾不存在或已移入回收站");
      opened.current = initialReviewId;
    }
  }, [initialReviewId, data]);
  useEffect(() => {
    onBusyChange?.(busy || dirty);
    return () => onBusyChange?.(false);
  }, [busy, dirty, onBusyChange]);
  async function refresh() {
    const next = await invoke<Snapshot>("review_snapshot");
    setData(next);
    setDays(next.settings.staleDays);
  }
  useEffect(() => {
    void refresh().catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);
  function choose(next: Draft) {
    if (dirty && !window.confirm("当前回顾尚未保存，放弃这些修改？")) return;
    setDraft(next);
    setDirty(false);
    setError("");
  }
  function edit(patch: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...patch } : null));
    setDirty(true);
  }
  async function send(action: Record<string, unknown>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const key = JSON.stringify(action);
      await retries.execute(
        key,
        (c) => JSON.stringify(c.action) === key,
        () => ({
          operationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          action,
        }),
        (c) => invoke("review_command", { command: c }),
      );
      if (action.type === "save") {
        setDraft(null);
        setDirty(false);
      }
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="review-view" aria-label="项目检查与周回顾">
      <h2>项目检查与周回顾</h2>
      {error && <p role="alert">{feedbackMessage(error)}</p>}
      {!data ? (
        <p>正在读取本机记录…</p>
      ) : (
        <>
          <section aria-label="项目检查">
            <h3>项目检查</h3>
            <p>
              检查活跃项目。推进证据包括已完成任务、关联的推进记录和恢复卡更新；“未记录”不代表没有实际工作。日期按{" "}
              {data.timeZone} 计算。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void send({
                  type: "settings",
                  staleDays: days,
                  expectedVersion: data.settings.version,
                });
              }}
            >
              <label>
                未记录推进的天数{" "}
                <input
                  type="number"
                  min="1"
                  max="365"
                  required
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                  disabled={busy}
                />
              </label>
              <button disabled={busy}>保存检查天数</button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void refresh().catch((e) => setError(String(e)))}
              >
                刷新检查
              </button>
            </form>
            {data.checks.length === 0 ? (
              <p>当前没有需要提醒的活跃项目。</p>
            ) : (
              <ul>
                {data.checks.map((p) => (
                  <li key={p.id}>
                    <button type="button" onClick={() => openProject(p.id)}>
                      {p.name}
                    </button>
                    <ul>
                      {p.reasons.map((r) => (
                        <li key={r}>{r}</li>
                      ))}
                    </ul>
                    {p.lastProgressAt && (
                      <small>
                        最近推进证据：
                        {new Date(p.lastProgressAt).toLocaleString("zh-CN", {
                          timeZone: data.timeZone,
                        })}
                      </small>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section aria-label="手动周回顾">
            <h3>手动周回顾</h3>
            <p>
              把成果和思考保存在独立记录中；保存不会创建任务或更改项目状态。
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                choose({
                  id: crypto.randomUUID(),
                  version: null,
                  start: data.today,
                  end: data.today,
                  achievements: "",
                  blockers: "",
                  stopPause: "",
                  nextFocus: "",
                  projectIds: [],
                })
              }
            >
              新建周回顾
            </button>
            <ul>
              {data.reviews.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => choose(r)}
                  >
                    周回顾 {r.start} — {r.end}
                  </button>
                  {r.projectIds.map((id) => {
                    const p = data.projects.find((p) => p.id === id);
                    return p ? (
                      <button
                        type="button"
                        key={id}
                        onClick={() => openProject(id)}
                      >
                        {p.name}
                        {p.archived ? "（已归档）" : ""}
                      </button>
                    ) : (
                      <span key={id}>关联项目已删除</span>
                    );
                  })}
                </li>
              ))}
            </ul>
            {draft && (
              <form
                aria-label="周回顾编辑器"
                onSubmit={(e) => {
                  e.preventDefault();
                  void send({
                    type: "save",
                    id: draft.id,
                    expectedVersion: draft.version,
                    start: draft.start,
                    end: draft.end,
                    achievements: draft.achievements,
                    blockers: draft.blockers,
                    stopPause: draft.stopPause,
                    nextFocus: draft.nextFocus,
                    projectIds: draft.projectIds,
                  });
                }}
              >
                <fieldset disabled={busy}>
                  <legend>
                    {draft.version === null ? "新建周回顾" : "编辑周回顾"}
                  </legend>
                  <div className="review-dates">
                    <label>
                      期间开始
                      <input
                        type="date"
                        required
                        value={draft.start}
                        max={draft.end || undefined}
                        onChange={(e) => edit({ start: e.target.value })}
                      />
                    </label>
                    <label>
                      期间结束
                      <input
                        type="date"
                        required
                        value={draft.end}
                        min={draft.start || undefined}
                        onChange={(e) => edit({ end: e.target.value })}
                      />
                    </label>
                  </div>
                  {(
                    [
                      ["achievements", "推进成果"],
                      ["blockers", "阻塞"],
                      ["stopPause", "停止 / 暂停"],
                      ["nextFocus", "下周重点"],
                    ] as const
                  ).map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <textarea
                        rows={3}
                        maxLength={25000}
                        value={draft[key]}
                        onChange={(e) => edit({ [key]: e.target.value })}
                      />
                    </label>
                  ))}
                  <fieldset>
                    <legend>关联项目</legend>
                    {data.projects.map((p) => (
                      <label className="review-project" key={p.id}>
                        <input
                          type="checkbox"
                          checked={draft.projectIds.includes(p.id)}
                          onChange={(e) =>
                            edit({
                              projectIds: e.target.checked
                                ? [...draft.projectIds, p.id]
                                : draft.projectIds.filter((id) => id !== p.id),
                            })
                          }
                        />
                        {p.name}
                        {p.archived ? "（已归档）" : ""}
                      </label>
                    ))}
                    {draft.projectIds
                      .filter((id) => !data.projects.some((p) => p.id === id))
                      .map((id) => (
                        <label className="review-project" key={id}>
                          <input
                            type="checkbox"
                            checked
                            onChange={() =>
                              edit({
                                projectIds: draft.projectIds.filter(
                                  (p) => p !== id,
                                ),
                              })
                            }
                          />
                          关联项目已删除（取消勾选后可保存）
                        </label>
                      ))}
                  </fieldset>
                  <button type="submit">
                    {busy ? "正在保存…" : "保存周回顾"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (!dirty || window.confirm("放弃未保存的回顾修改？")) {
                        setDraft(null);
                        setDirty(false);
                      }
                    }}
                  >
                    取消
                  </button>
                </fieldset>
              </form>
            )}
          </section>
        </>
      )}
    </section>
  );
}
