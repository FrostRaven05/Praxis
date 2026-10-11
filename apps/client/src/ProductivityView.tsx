import { useLanRefresh } from "./useLanRefresh";
import { SyncedNotes } from "./SyncedNotes";
import { SubtaskComposer } from "./SubtaskComposer";
import { TrashView } from "./TrashView";
import { SearchViews } from "./SearchViews";
import { ReviewView } from "./ReviewView";
import { RepeatView } from "./RepeatView";
import { HabitsView } from "./HabitsView";
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  calendarDate,
  dateAfter,
  dayRows,
  rescheduleTasks,
  timeLabel,
  timeDay,
  planConflict,
  subtree,
  terminal,
  type WorkSnapshot,
  type WorkTask,
  type WorkProject,
  type TimeValue,
  type DayNote,
} from "@praxis/application";
import { RetriableCommands } from "../../../packages/application/src/retriable-commands";
import { RelatedRecords } from "./RelatedRecords";
import "./productivity.css";
type Action = Record<string, unknown> & { type: string };
type Command = { operationId: string; occurredAt: string; action: Action };
const retry = new RetriableCommands<Command>();
export const readWork = () => invoke<WorkSnapshot>("productivity_snapshot");
async function send(action: Action) {
  await retry.execute(
    action.type,
    (c) => JSON.stringify(c.action) === JSON.stringify(action),
    () => ({
      operationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      action,
    }),
    (command) => invoke("productivity_command", { command }),
  );
}
const statuses: Record<string, string> = {
  todo: "待办",
  in_progress: "进行中",
  blocked: "阻塞",
  waiting: "等待",
  completed: "已完成",
  cancelled: "已取消",
};
const projectStatuses: Record<string, string> = {
  active: "活跃",
  paused: "暂停",
  completed: "已完成",
  cancelled: "已取消",
  draft: "草稿",
};
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
type EditorGuard = (scope: string, dirty: boolean) => void;
// A draft keeps the version that supplied its fields. Clean forms follow refreshed data.
function useGuardedDraft<T>(
  value: T,
  scope: string,
  onDirtyChange: EditorGuard,
) {
  const [base, setBase] = useState(value);
  const [draft, setDraft] = useState(value);
  const dirty = JSON.stringify(base) !== JSON.stringify(draft);
  const valueKey = JSON.stringify(value);
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => {
    if (!dirty) {
      setBase(latest.current);
      setDraft(latest.current);
    }
  }, [valueKey, dirty]);
  useEffect(() => {
    onDirtyChange(scope, dirty);
    return () => onDirtyChange(scope, false);
  }, [scope, dirty, onDirtyChange]);
  return {
    draft,
    setDraft,
    base,
    dirty,
    accept: () => setBase(draft),
    discard: () => {
      setBase(latest.current);
      setDraft(latest.current);
    },
  };
}
export function openWorkTask(id: string) {
  window.dispatchEvent(new CustomEvent("praxis-work-task", { detail: id }));
}
export function ProductivityView({
  initialTaskId,
  initialProjectId,
  initialViewId,
  initialReviewId,
  viewRevision,
  onChanged,
  onBusyChange,
}: {
  initialTaskId?: string | null;
  initialProjectId?: string | null;
  initialViewId?: string | null;
  initialReviewId?: string | null;
  viewRevision?: number;
  onChanged: () => void;
  onBusyChange: (v: boolean) => void;
}) {
  const [data, setData] = useState<WorkSnapshot | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [childBusy, setChildBusy] = useState(false),
    [tab, setTab] = useState("today"),
    [selectedDate, setDate] = useState(""),
    [days, setDays] = useState(7),
    [edit, setEdit] = useState<WorkTask | "new" | null>(null),
    [project, setProject] = useState<string | null>(null),
    [confirm, setConfirm] = useState<{
      action: Action;
      description: string;
    } | null>(null),
    [clock, setClock] = useState(() => new Date());
  const savingRef = useRef(false);
  const [confirmedAction, setConfirmedAction] = useState<Action | null>(null);
  const [dirtyEditors, setDirtyEditors] = useState<Set<string>>(
    () => new Set(),
  );
  const setEditorDirty = useCallback<EditorGuard>((scope, dirty) => {
    setDirtyEditors((old) => {
      if (old.has(scope) === dirty) return old;
      const next = new Set(old);
      if (dirty) next.add(scope);
      else next.delete(scope);
      return next;
    });
    if (dirty && scope.startsWith("day:"))
      setDate((old) => old || scope.slice(4));
  }, []);
  const hasDraft = dirtyEditors.size > 0;
  const automaticBlocked = useRef(false);
  automaticBlocked.current =
    busy || childBusy || edit !== null || confirm !== null || hasDraft;
  const readGeneration = useRef(0);
  useLanRefresh(
    readWork,
    setData,
    busy || childBusy || edit !== null || confirm !== null || hasDraft,
  );
  const openedId = useRef<string | null>(null);
  useEffect(() => {
    if (initialReviewId) setTab("review");
  }, [initialReviewId]);
  useEffect(() => {
    if (initialViewId) setTab("search");
  }, [initialViewId, viewRevision]);
  useEffect(() => {
    if (initialProjectId) {
      setProject(initialProjectId);
      setTab("projects");
    }
  }, [initialProjectId]);
  const refresh = async (automatic = false) => {
    const generation = ++readGeneration.current;
    const s = await readWork();
    if (
      generation === readGeneration.current &&
      (!automatic || !automaticBlocked.current)
    )
      setData(s);
    return s;
  };
  useEffect(() => {
    void refresh(true).catch((e) => setError(errorText(e)));
  }, [tab]);
  useEffect(() => {
    void refresh(true).catch((e) => setError(errorText(e)));
    const timer = setInterval(() => setClock(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    onBusyChange(
      busy || childBusy || edit !== null || confirm !== null || hasDraft,
    );
    return () => onBusyChange(false);
  }, [busy, childBusy, edit, confirm, hasDraft, onBusyChange]);
  useEffect(() => {
    if (initialTaskId && data && openedId.current !== initialTaskId) {
      openedId.current = initialTaskId;
      setEdit(data.tasks.find((t) => t.id === initialTaskId) ?? null);
    }
  }, [initialTaskId, data]);
  async function save(action: Action) {
    if (savingRef.current) return false;
    savingRef.current = true;
    setBusy(true);
    setError("");
    try {
      await send(action);
      await refresh();
      onChanged();
      return true;
    } catch (e) {
      setError(errorText(e));
      return false;
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }
  const zone = data?.settings[0]?.timeZone ?? "UTC",
    today = calendarDate(clock, zone),
    date = selectedDate || today;
  function changeStatus(t: WorkTask, status: string) {
    if (!data || busy || confirm || edit || childBusy || hasDraft) return;
    const related = subtree(data.tasks, t.id).filter((t) => !terminal(t));
    const parents: WorkTask[] = [];
    let p = data.tasks.find((x) => x.id === t.parentId);
    while (p) {
      parents.push(p);
      p = data.tasks.find((x) => x.id === p!.parentId);
    }
    const proj = data.projects.find((p) => p.id === t.projectId);
    setConfirm({
      action: {
        type: "status",
        id: t.id,
        expectedVersion: t.version,
        status,
        confirmRelated: true,
        expectedTasks: data.tasks.map((t) => [t.id, t.version]),
      },
      description: `将「${t.title}」设为${statuses[status]}。${
        ["completed", "cancelled"].includes(status)
          ? `会一并处理未结束子任务：${
              related
                .filter((x) => x.id !== t.id)
                .map((x) => x.title)
                .join("、") || "无"
            }。`
          : `若父任务已结束，将一并重开：${
              parents
                .filter(terminal)
                .map((x) => x.title)
                .join("、") || "无"
            }。${proj && (["completed", "cancelled", "archived"].includes(proj.status) || proj.archivedAt) ? `同时重开项目「${proj.name}」并取消归档。` : ""}`
      }`,
    });
  }
  function row(t: WorkTask, reasons: string[] = []) {
    const p = data?.projects.find((p) => p.id === t.projectId);
    return (
      <article className="work-row" key={t.id}>
        <div>
          <button
            className="work-title"
            disabled={busy || !!confirm || !!edit || childBusy || hasDraft}
            onClick={() => setEdit(t)}
          >
            {t.title}
          </button>
          <div className="work-badges">
            <span>P{t.priority}</span>
            <span>{statuses[t.status]}</span>
            {t.important === 1 && <span>旧重要标记</span>}
            {p && (
              <span>
                {p.name} · {projectStatuses[p.status]}
              </span>
            )}
            {reasons.map((r) => (
              <span key={r}>{r}</span>
            ))}
            {t.labels.map((id) => (
              <span key={id}>
                #{data?.labels.find((l) => l.id === id)?.name}
              </span>
            ))}
          </div>
          <small>
            计划 {timeLabel(t.plan, zone)} · 截止 {timeLabel(t.deadline, zone)}{" "}
            · 跟进 {timeLabel(t.followUp, zone)}
          </small>
          {t.status === "waiting" && (
            <p>
              等待 {t.waitingFor || "未指定对象"}：
              {t.waitingNote || "未填写说明"}
            </p>
          )}
        </div>
        <select
          disabled={busy || !!confirm || !!edit || childBusy || hasDraft}
          aria-label={`${t.title} 状态`}
          value={t.status}
          onChange={(e) => changeStatus(t, e.target.value)}
        >
          {Object.entries(statuses).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </article>
    );
  }
  if (!data)
    return (
      <section className="work-view">
        <p>{error || "正在读取本地工作空间…"}</p>
        <button
          onClick={() => void refresh().catch((e) => setError(errorText(e)))}
        >
          重新加载
        </button>
      </section>
    );
  const dayNote = data.days.find((d) => d.date === date);
  return (
    <section className="work-view">
      <header>
        <h1>今日与近期</h1>
        <p>本地保存 · 工作空间时区 {data.settings[0]?.timeZone ?? "待确认"}</p>
      </header>
      {error && <p role="alert">{error}</p>}
      <fieldset disabled={busy || childBusy || !!edit || !!confirm || hasDraft}>
        <nav className="work-tabs">
          {[
            ["today", "今日"],
            ["upcoming", "近期"],
            ["all", "全部任务"],
            ["projects", "项目与分区"],
            ["settings", "时区与标签"],
            ["repeat", "重复任务"],
            ["habits", "习惯"],
            ["trash", "回收站"],
            ["search", "搜索与视图"],
            ["review", "项目检查与周回顾"],
            ["notes", "策略决策与专注"],
          ].map(([k, v]) => (
            <button key={k} aria-pressed={tab === k} onClick={() => setTab(k!)}>
              {v}
            </button>
          ))}
          <button onClick={() => setEdit("new")}>快速任务</button>
        </nav>
      </fieldset>
      {!data.settings.length ? (
        <ZoneEditor data={data} save={save} onDirtyChange={setEditorDirty} />
      ) : (
        <>
          {(tab === "today" || tab === "upcoming") && (
            <label>
              所选日期{" "}
              <input
                aria-label="所选日期"
                type="date"
                disabled={hasDraft}
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
              {date !== today && (
                <strong> 浏览 {date}（当前属性，不还原历史快照）</strong>
              )}
              <button disabled={hasDraft} onClick={() => setDate("")}>
                回到今日
              </button>
            </label>
          )}
          {tab === "today" && (
            <>
              <HabitsView date={date} compact />
              <DailyEditor
                key={date}
                date={date}
                data={data}
                note={dayNote}
                save={save}
                zone={zone}
                onDirtyChange={setEditorDirty}
              />
              {[0, 1, 2, 3].map((g) => (
                <section key={g}>
                  <h2>{["截止事项", "每日重点", "当日安排", "到期跟进"][g]}</h2>
                  {dayRows(data, date, clock, zone)
                    .filter((r) => r.group === g)
                    .map((r) => row(r.task, r.reasons))}
                </section>
              ))}
              {dayRows(data, date, clock, zone).length === 0 && (
                <p>这个日期暂无待处理事项。</p>
              )}
              {date === today && (
                <details>
                  <summary>
                    待重排（{rescheduleTasks(data, clock, zone).length}）
                  </summary>
                  <p>过去计划不会自动延期。打开任务可改期、移除计划或拆分。</p>
                  {rescheduleTasks(data, clock, zone).map((t) =>
                    row(t, ["过去计划"]),
                  )}
                </details>
              )}
            </>
          )}
          {tab === "upcoming" && (
            <>
              <button onClick={() => setTab("repeat")}>
                管理重复规则与补齐实例
              </button>
              <p>重复任务可在规则页预览并按批次补齐。</p>
            </>
          )}
          {tab === "repeat" && <RepeatView />}
          {tab === "notes" && <SyncedNotes onBusyChange={setChildBusy} />}
          {tab === "review" && (
            <ReviewView
              initialReviewId={initialReviewId ?? null}
              onBusyChange={setChildBusy}
            />
          )}
          {tab === "search" && (
            <SearchViews
              key={viewRevision}
              initialViewId={initialViewId ?? null}
              onChanged={onChanged}
            />
          )}
          {tab === "habits" && <HabitsView />}
          {tab === "trash" && (
            <TrashView
              onChanged={() => {
                void refresh().catch((e) => setError(errorText(e)));
                onChanged();
              }}
            />
          )}
          {tab === "upcoming" && (
            <>
              <label>
                范围{" "}
                <select
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                >
                  <option value={7}>7 天</option>
                  <option value={14}>14 天</option>
                  <option value={30}>30 天</option>
                </select>
              </label>
              {Array.from({ length: days }, (_, i) => dateAfter(date, i)).map(
                (d) => (
                  <section key={d}>
                    <h2>{d}</h2>
                    {data.tasks
                      .filter((t) => !terminal(t))
                      .map((t) => ({
                        t,
                        reasons: (
                          [
                            ["plan", "计划"],
                            ["deadline", "截止"],
                            ["followUp", "跟进"],
                          ] as const
                        )
                          .filter(([key]) => timeDay(t[key], zone) === d)
                          .map(([, label]) => label),
                      }))
                      .filter((x) => x.reasons.length)
                      .map(({ t, reasons }) => row(t, reasons))}
                  </section>
                ),
              )}
            </>
          )}
          {tab === "all" && (
            <>
              {data.tasks.map((t) => row(t))}
              {!data.tasks.length && (
                <p>还没有任务。使用快速任务创建，属性会先预览。</p>
              )}
            </>
          )}
          {tab === "projects" && (
            <>
              <label>
                选择项目{" "}
                <select
                  value={project ?? ""}
                  disabled={hasDraft}
                  onChange={(e) => setProject(e.target.value || null)}
                >
                  <option value="">请选择</option>
                  {data.projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                      {p.archivedAt ? "（已归档）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {data.projects
                .filter((p) => p.id === project)
                .map((p) => (
                  <ProjectEditor
                    key={p.id}
                    project={p}
                    data={data}
                    save={save}
                    confirm={setConfirm}
                    row={row}
                    onDirtyChange={setEditorDirty}
                    confirmedAction={confirmedAction}
                  />
                ))}
            </>
          )}
          {tab === "settings" && (
            <>
              <ZoneEditor
                data={data}
                save={save}
                onDirtyChange={setEditorDirty}
              />
              <LabelEditor
                data={data}
                save={save}
                onDirtyChange={setEditorDirty}
              />
              <details>
                <summary>升级映射报告</summary>
                <p>{data.migrationReport}</p>
              </details>
              <details>
                <summary>活动记录</summary>
                {data.events.map((e) => (
                  <p key={e.id}>
                    {e.occurredAt} · {e.payload.action.type} ·{" "}
                    {data.tasks.find((t) => t.id === e.entityId)?.title ??
                      data.projects.find((p) => p.id === e.entityId)?.name ??
                      e.entityId}
                  </p>
                ))}
              </details>
            </>
          )}
        </>
      )}
      {edit && (
        <div
          className="work-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="任务属性"
        >
          <div>
            {error && <p role="alert">{error}</p>}
            <TaskEditor
              key={edit === "new" ? "new" : edit.id}
              task={edit === "new" ? null : edit}
              data={data}
              zone={zone}
              save={save}
              onSplitSaved={async () => {
                await refresh();
                onChanged();
                setEdit(null);
              }}
              close={() => setEdit(null)}
              confirm={setConfirm}
            />
          </div>
        </div>
      )}
      {confirm && (
        <div
          className="work-overlay"
          role="dialog"
          aria-modal="true"
          aria-label="确认影响"
        >
          <div className="work-dialog">
            <h2>确认影响</h2>
            {error && <p role="alert">{error}</p>}
            <p>{confirm.description}</p>
            <button
              disabled={busy}
              onClick={async () => {
                if (await save(confirm.action)) {
                  setConfirmedAction(confirm.action);
                  setConfirm(null);
                  setEdit(null);
                }
              }}
            >
              确认执行
            </button>
            <button disabled={busy} onClick={() => setConfirm(null)}>
              返回检查
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
function TimeInput({
  label,
  value,
  onChange,
  zone,
}: {
  label: string;
  value: TimeValue | null;
  onChange: (v: TimeValue | null) => void;
  zone: string;
}) {
  return (
    <fieldset>
      <legend>{label}</legend>
      <select
        aria-label={`${label}类型`}
        value={value?.kind ?? "none"}
        onChange={(e) =>
          onChange(
            e.target.value === "none"
              ? null
              : e.target.value === "date"
                ? { kind: "date", date: calendarDate(new Date(), zone) }
                : {
                    kind: "instant",
                    atUtc: new Date().toISOString(),
                    displayTimezone: zone,
                  },
          )
        }
      >
        <option value="none">未设置</option>
        <option value="date">日期</option>
        <option value="instant">确定时刻</option>
      </select>
      {value?.kind === "date" && (
        <input
          aria-label={label}
          type="date"
          value={value.date}
          onChange={(e) => onChange({ ...value, date: e.target.value })}
        />
      )}{" "}
      {value?.kind === "instant" && (
        <>
          <input
            aria-label={`${label} UTC时刻`}
            type="datetime-local"
            value={value.atUtc.replace(/Z$/, "").slice(0, 16)}
            onChange={(e) =>
              onChange({ ...value, atUtc: e.target.value + ":00Z" })
            }
          />
          <span>UTC 输入；显示为 {timeLabel(value, zone)}</span>
        </>
      )}
    </fieldset>
  );
}
function TaskEditor({
  task,
  data,
  zone,
  save,
  close,
  confirm,
  onSplitSaved,
}: {
  task: WorkTask | null;
  data: WorkSnapshot;
  zone: string;
  save: (a: Action) => Promise<boolean>;
  close: () => void;
  onSplitSaved: () => Promise<void>;
  confirm: (v: { action: Action; description: string }) => void;
}) {
  const [id] = useState(() => task?.id ?? crypto.randomUUID()),
    [title, setTitle] = useState(task?.title ?? ""),
    [notes, setNotes] = useState(task?.notes ?? ""),
    [plan, setPlan] = useState(task?.plan ?? null),
    [deadline, setDeadline] = useState(task?.deadline ?? null),
    [followUp, setFollowUp] = useState(task?.followUp ?? null),
    [priority, setPriority] = useState(task?.priority ?? 4),
    [labels, setLabels] = useState(task?.labels ?? []),
    [waitingFor, setWaitingFor] = useState(task?.waitingFor ?? ""),
    [waitingNote, setWaitingNote] = useState(task?.waitingNote ?? ""),
    [project, setProject] = useState(task?.projectId ?? ""),
    [parent, setParent] = useState(task?.parentId ?? ""),
    [section, setSection] = useState(task?.sectionId ?? ""),
    [preview, setPreview] = useState(false),
    [saving, setSaving] = useState(false);
  const action = {
    type: "task",
    id,
    expectedVersion: task?.version ?? null,
    title,
    notes,
    plan,
    deadline,
    followUp,
    priority,
    labels,
    waitingFor,
    waitingNote,
    projectId: task ? task.projectId : project || null,
  };
  const attributesDirty =
    !!task &&
    (title !== task.title ||
      notes !== task.notes ||
      priority !== task.priority ||
      waitingFor !== task.waitingFor ||
      waitingNote !== task.waitingNote ||
      JSON.stringify([plan, deadline, followUp, labels]) !==
        JSON.stringify([task.plan, task.deadline, task.followUp, task.labels]));
  return (
    <div className="work-dialog">
      <h2>{task ? "编辑任务" : "快速任务"}</h2>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (!preview) {
            setPreview(true);
            return;
          }
          setSaving(true);
          try {
            if (await save(action)) close();
          } finally {
            setSaving(false);
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && e.nativeEvent.isComposing)
            e.preventDefault();
        }}
      >
        <fieldset disabled={saving}>
          <label>
            标题{" "}
            <input
              aria-label="任务标题"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setPreview(false);
              }}
              required
              maxLength={1000}
            />
          </label>
          <label>
            说明{" "}
            <textarea
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setPreview(false);
              }}
            />
          </label>
          <label>
            项目{" "}
            <select
              aria-label="任务项目"
              disabled={!!task}
              value={task ? (task.projectId ?? "") : project}
              onChange={(e) => {
                setProject(e.target.value);
                setPreview(false);
              }}
            >
              <option value="">独立任务</option>
              {data.projects
                .filter(
                  (p) =>
                    !p.archivedAt &&
                    !["completed", "cancelled"].includes(p.status),
                )
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </select>
          </label>
          <label>
            优先级{" "}
            <select
              aria-label="优先级"
              value={priority}
              onChange={(e) => {
                setPriority(Number(e.target.value));
                setPreview(false);
              }}
            >
              {[1, 2, 3, 4].map((p) => (
                <option key={p} value={p}>
                  P{p}
                </option>
              ))}
            </select>
          </label>
          <TimeInput
            label="计划"
            value={plan}
            onChange={(v) => {
              setPlan(v);
              setPreview(false);
            }}
            zone={zone}
          />
          <TimeInput
            label="真实截止"
            value={deadline}
            onChange={(v) => {
              setDeadline(v);
              setPreview(false);
            }}
            zone={zone}
          />
          <TimeInput
            label="跟进"
            value={followUp}
            onChange={(v) => {
              setFollowUp(v);
              setPreview(false);
            }}
            zone={zone}
          />
          {planConflict({ plan, deadline }, zone) && (
            <p role="alert">计划晚于真实截止。允许保存，请确认两个值。</p>
          )}
          <fieldset>
            <legend>标签（可取消选择）</legend>
            {data.labels.map((l) => (
              <label key={l.id}>
                <input
                  type="checkbox"
                  checked={labels.includes(l.id)}
                  onChange={(e) => {
                    setLabels(
                      e.target.checked
                        ? [...labels, l.id]
                        : labels.filter((id) => id !== l.id),
                    );
                    setPreview(false);
                  }}
                />
                {l.name}
              </label>
            ))}
            {!data.labels.length && <p>可在“时区与标签”中创建可复用标签。</p>}
          </fieldset>
          <label>
            等待对象{" "}
            <input
              value={waitingFor}
              onChange={(e) => {
                setWaitingFor(e.target.value);
                setPreview(false);
              }}
            />
          </label>
          <label>
            等待说明{" "}
            <textarea
              value={waitingNote}
              onChange={(e) => {
                setWaitingNote(e.target.value);
                setPreview(false);
              }}
            />
          </label>
          {preview && (
            <div className="work-preview">
              <h3>保存预览</h3>
              <p>
                {title} · P{priority} ·{" "}
                {data.projects.find((p) => p.id === action.projectId)?.name ??
                  "独立任务"}
              </p>
              <p>
                计划 {timeLabel(plan, zone)}；截止 {timeLabel(deadline, zone)}
                ；跟进 {timeLabel(followUp, zone)}
              </p>
              <p>
                标签：
                {labels
                  .map((id) => data.labels.find((l) => l.id === id)?.name)
                  .join("、") || "无"}
                。原文不会自动解析或删减。
              </p>
            </div>
          )}
          <button type="submit">{preview ? "确认保存" : "预览属性"}</button>
          <button type="button" onClick={close}>
            取消编辑
          </button>
        </fieldset>
      </form>
      {task && (
        <>
          <details>
            <summary>移动、分区与父子关系</summary>
            <p>
              兼容保留多级树；子任务继承父项分区，移动保留整个子树及原排序。
            </p>
            <label>
              目标项目{" "}
              <select
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  setParent("");
                  setSection("");
                }}
              >
                <option value="">独立任务</option>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              父任务{" "}
              <select
                value={parent}
                onChange={(e) => setParent(e.target.value)}
              >
                <option value="">顶层任务</option>
                {data.tasks
                  .filter(
                    (t) =>
                      t.projectId === (project || null) &&
                      !subtree(data.tasks, task.id).some(
                        (x) => x.id === t.id,
                      ) &&
                      !terminal(t),
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              分区{" "}
              <select
                aria-label="分区"
                disabled={!!parent}
                value={section}
                onChange={(e) => setSection(e.target.value)}
              >
                <option value="">未分区</option>
                {data.sections
                  .filter((s) => s.projectId === project)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </select>
            </label>
            <button
              disabled={attributesDirty || saving}
              onClick={() => {
                const tree = subtree(data.tasks, task.id);
                confirm({
                  action: {
                    type: "move",
                    id: task.id,
                    expectedVersion: task.version,
                    projectId: project || null,
                    parentId: parent || null,
                    sectionId: section || null,
                    confirmCount: tree.length,
                    expectedTasks: data.tasks.map((t) => [t.id, t.version]),
                  },
                  description: `将移动 ${tree.length} 项：${tree.map((t) => t.title).join("、")}。父子归属一起更新，失效下一步将清除。`,
                });
              }}
            >
              预览移动
            </button>
          </details>
          {attributesDirty ? (
            <p>请先保存或取消属性修改，再移动或拆分任务。</p>
          ) : (
            <SubtaskComposer
              task={{
                taskId: task.id,
                title: task.title,
                status: task.status,
                version: task.version,
                createdAt: task.createdAt,
                executionDate:
                  data.legacyPlans.find((p) => p.taskId === task.id)?.date ??
                  null,
                completionDate: null,
              }}
              onSaved={onSplitSaved}
            />
          )}
          <RelatedRecords targetType="task" targetId={task.id} />
          <details>
            <summary>任务活动</summary>
            {data.events
              .filter((e) => e.entityId === task.id)
              .map((e) => (
                <p key={e.id}>
                  {e.occurredAt} · {e.payload.action.type}
                </p>
              ))}
          </details>
        </>
      )}
    </div>
  );
}
function DailyEditor({
  date,
  data,
  note,
  save,
  zone,
  onDirtyChange,
}: {
  date: string;
  data: WorkSnapshot;
  note: DayNote | undefined;
  save: (a: Action) => Promise<boolean>;
  zone: string;
  onDirtyChange: EditorGuard;
}) {
  const form = useGuardedDraft(
    {
      outcome: note?.outcome ?? "",
      closing: note?.closing ?? "",
      focus:
        note?.focusIds ??
        data.legacyPlans
          .filter((p) => p.date === date && p.focus)
          .sort((a, b) => a.rank - b.rank)
          .map((p) => p.taskId),
      version: note?.version ?? null,
    },
    "day:" + date,
    onDirtyChange,
  );
  const { outcome, closing, focus } = form.draft;
  const setOutcome = (outcome: string) =>
    form.setDraft((d) => ({ ...d, outcome }));
  const setClosing = (closing: string) =>
    form.setDraft((d) => ({ ...d, closing }));
  const setFocus = (focus: string[] | ((f: string[]) => string[])) =>
    form.setDraft((d) => ({
      ...d,
      focus: typeof focus === "function" ? focus(d.focus) : focus,
    }));
  const [notice, setNotice] = useState("");
  return (
    <details className="work-daily" open>
      <summary>{date} 的结果与重点</summary>
      <label>
        主要推进结果{" "}
        <textarea
          aria-label="主要推进结果"
          value={outcome}
          onChange={(e) => setOutcome(e.target.value)}
        />
      </label>
      <label>
        收尾备注{" "}
        <textarea
          aria-label="收尾备注"
          value={closing}
          onChange={(e) => setClosing(e.target.value)}
        />
      </label>
      <details>
        <summary>选择重点（{focus.length}）</summary>
        {focus.length > 3 && (
          <p>重点已超过三个，可以保存；建议减少以保持专注。</p>
        )}
        {data.tasks.map((t) => (
          <label key={t.id}>
            <input
              type="checkbox"
              checked={focus.includes(t.id)}
              onChange={(e) =>
                setFocus(
                  e.target.checked
                    ? [...focus, t.id]
                    : focus.filter((id) => id !== t.id),
                )
              }
            />
            {t.title} · 原计划 {timeLabel(t.plan, zone)}
            {timeDay(t.plan, zone) !== date ? "（加入重点不会改期）" : ""}
          </label>
        ))}
        <ol>
          {focus.map((id, i) => (
            <li key={id}>
              {data.tasks.find((t) => t.id === id)?.title ?? "失效引用"}{" "}
              <button
                disabled={i === 0}
                onClick={() =>
                  setFocus((f) => {
                    const n = [...f];
                    [n[i - 1], n[i]] = [n[i]!, n[i - 1]!];
                    return n;
                  })
                }
              >
                上移
              </button>
            </li>
          ))}
        </ol>
      </details>
      <button
        onClick={async () => {
          if (
            await save({
              type: "day",
              date,
              outcome,
              closing,
              focusIds: focus,
              expectedVersion: form.base.version,
            })
          ) {
            form.accept();
            setNotice("已保存");
          }
        }}
      >
        保存每日结果
      </button>
      {form.dirty && (
        <button
          onClick={() => {
            form.discard();
            setNotice("");
          }}
        >
          放弃每日修改
        </button>
      )}
      <span role="status">{notice}</span>
    </details>
  );
}
function ZoneEditor({
  data,
  save,
  onDirtyChange,
}: {
  data: WorkSnapshot;
  save: (a: Action) => Promise<boolean>;
  onDirtyChange: EditorGuard;
}) {
  const form = useGuardedDraft(
    {
      zone:
        data.settings[0]?.timeZone ??
        Intl.DateTimeFormat().resolvedOptions().timeZone,
      version: data.settings[0]?.version ?? null,
    },
    "zone",
    onDirtyChange,
  );
  const zone = form.draft.zone;
  const setZone = (zone: string) => form.setDraft((d) => ({ ...d, zone }));
  const [preview, setPreview] = useState(false),
    [invalid, setInvalid] = useState("");
  const [templates, setTemplates] = useState<
    Array<{
      template: {
        id: string;
        title: string;
        version: number;
        enabled: boolean;
        timeZone: string;
      };
      futureTasks: Array<{ id: string; title: string; occurrenceKey: string }>;
    }>
  >([]);
  const [reading, setReading] = useState(false);
  const old = form.base.zone;
  useEffect(() => {
    onDirtyChange("zone-preview", preview || reading);
    return () => onDirtyChange("zone-preview", false);
  }, [preview, reading, onDirtyChange]);
  return (
    <section>
      <h2>工作空间时区</h2>
      <p>
        日期文字与完成历史保持不变，设备时区变化不会修改此设置。确定时刻不变，显示日期可能改变。已有习惯记录保留原日期和时区；启用的重复模板未来规则随此次确认更新。
      </p>
      <label>
        IANA 时区{" "}
        <input
          aria-label="工作空间时区"
          disabled={reading}
          value={zone}
          onChange={(e) => {
            setZone(e.target.value);
            setPreview(false);
          }}
        />
      </label>
      <button
        disabled={reading}
        onClick={async () => {
          setReading(true);
          setPreview(false);
          try {
            new Intl.DateTimeFormat("zh-CN", { timeZone: zone }).format();
            const snapshot = await invoke<{ templates: typeof templates }>(
              "recurrence_snapshot",
            );
            setTemplates(snapshot.templates.filter((r) => r.template.enabled));
            setPreview(true);
            setInvalid("");
          } catch (e) {
            setInvalid(
              e instanceof RangeError ? "请输入有效 IANA 时区" : errorText(e),
            );
          } finally {
            setReading(false);
          }
        }}
      >
        预览时区影响
      </button>
      {invalid && <p role="alert">{invalid}</p>}
      {preview && (
        <>
          <p>
            {old} → {zone}。日期型值保持原文字。
          </p>
          <p>
            以下启用模板从明日起使用新时区。已生成实例的原定日期、身份和历史完成记录不变；尚未展开的日期按新时区解释。
          </p>
          {templates.map(({ template, futureTasks }) => (
            <details key={template.id}>
              <summary>
                {template.title}：{template.timeZone} → {zone}（
                {futureTasks.length} 个已生成未来实例保持原日期）
              </summary>
              {futureTasks.map((task) => (
                <p key={task.id}>
                  {task.title} · 原定 {task.occurrenceKey}
                </p>
              ))}
            </details>
          ))}
          {data.tasks.flatMap((t) =>
            (["plan", "deadline", "followUp"] as const)
              .filter((k) => t[k]?.kind === "instant")
              .map((k) => (
                <p key={t.id + k}>
                  {t.title} · {k}：{timeLabel(t[k], old)} →{" "}
                  {timeLabel(t[k], zone)}
                </p>
              )),
          )}
          <button
            onClick={async () => {
              if (
                await save({
                  type: "zone",
                  timeZone: zone,
                  expectedVersion: form.base.version,
                  expectedTemplates: templates.map(({ template }) => [
                    template.id,
                    template.version,
                  ]),
                })
              ) {
                form.accept();
                setPreview(false);
              }
            }}
          >
            确认工作空间时区
          </button>
        </>
      )}
      {(form.dirty || preview) && (
        <button
          disabled={reading}
          onClick={() => {
            form.discard();
            setPreview(false);
            setInvalid("");
          }}
        >
          放弃时区修改
        </button>
      )}
    </section>
  );
}
function LabelEditor({
  data,
  save,
  onDirtyChange,
}: {
  data: WorkSnapshot;
  save: (a: Action) => Promise<boolean>;
  onDirtyChange: EditorGuard;
}) {
  const [id, setId] = useState(""),
    [newId, setNewId] = useState(() => crypto.randomUUID());
  const selected = data.labels.find((l) => l.id === id);
  const form = useGuardedDraft(
    { name: selected?.name ?? "", version: selected?.version ?? null },
    "label",
    onDirtyChange,
  );
  const name = form.draft.name;
  const setName = (name: string) => form.setDraft((d) => ({ ...d, name }));
  useEffect(() => {
    if (id && !selected && !form.dirty) setId("");
  }, [id, selected, form.dirty]);
  return (
    <section>
      <h2>标签</h2>
      <select
        aria-label="编辑标签"
        value={id}
        disabled={form.dirty}
        onChange={(e) => {
          setId(e.target.value);
        }}
      >
        <option value="">新建标签</option>
        {data.labels.map((l) => (
          <option key={l.id} value={l.id}>
            {l.name}
          </option>
        ))}
      </select>
      <input
        aria-label="标签名称"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <button
        onClick={async () => {
          if (
            await save({
              type: "label",
              id: id || newId,
              name,
              expectedVersion: form.base.version,
            })
          ) {
            form.accept();
            setId("");
            setNewId(crypto.randomUUID());
          }
        }}
      >
        保存标签
      </button>
      {form.dirty && <button onClick={form.discard}>放弃标签修改</button>}
      <p>重命名保留标签身份和所有任务引用。</p>
    </section>
  );
}
function ProjectEditor({
  project: p,
  data,
  save,
  confirm,
  row,
  onDirtyChange,
  confirmedAction,
}: {
  project: WorkProject;
  data: WorkSnapshot;
  save: (a: Action) => Promise<boolean>;
  confirm: (v: { action: Action; description: string }) => void;
  row: (t: WorkTask, r?: string[]) => React.ReactNode;
  onDirtyChange: EditorGuard;
  confirmedAction: Action | null;
}) {
  const form = useGuardedDraft(
    {
      status: p.status === "draft" ? "active" : p.status,
      archive: !!p.archivedAt,
      focused: !!p.focused,
      cancel: false,
      version: p.version,
      planVersion: p.planVersion,
    },
    "project:" + p.id,
    onDirtyChange,
  );
  const { status, archive, focused, cancel } = form.draft;
  const setStatus = (status: string) =>
    form.setDraft((d) => ({ ...d, status }));
  const setArchive = (archive: boolean) =>
    form.setDraft((d) => ({ ...d, archive }));
  const setFocused = (focused: boolean) =>
    form.setDraft((d) => ({ ...d, focused }));
  const setCancel = (cancel: boolean) =>
    form.setDraft((d) => ({ ...d, cancel }));
  const [section, setSection] = useState(""),
    [sectionId, setSectionId] = useState(() => crypto.randomUUID());
  const tasks = data.tasks.filter((t) => t.projectId === p.id),
    top = tasks.filter((t) => !t.parentId),
    leaves = tasks.filter((t) => !tasks.some((c) => c.parentId === t.id)),
    remaining = tasks.filter((t) => !terminal(t)),
    selected = data.sections.find((s) => s.id === section);
  const sectionForm = useGuardedDraft(
    {
      name: selected?.name ?? "",
      rank: selected?.rank ?? 0,
      version: selected?.version ?? null,
    },
    "section:" + p.id,
    onDirtyChange,
  );
  const { name, rank } = sectionForm.draft;
  const setName = (name: string) =>
    sectionForm.setDraft((d) => ({ ...d, name }));
  const setRank = (rank: number) =>
    sectionForm.setDraft((d) => ({ ...d, rank }));
  useEffect(() => {
    if (section && !selected && !sectionForm.dirty) setSection("");
  }, [section, selected, sectionForm.dirty]);
  useEffect(() => {
    if (confirmedAction?.type === "project" && confirmedAction.id === p.id)
      form.discard();
    if (
      confirmedAction?.type === "section" &&
      confirmedAction.projectId === p.id
    ) {
      sectionForm.discard();
      setSection("");
    }
  }, [confirmedAction]);
  return (
    <section>
      <h2>{p.name}</h2>
      <p>
        顶层：已完成 {top.filter((t) => t.status === "completed").length}
        、未完成 {top.filter((t) => !terminal(t)).length}、已取消{" "}
        {top.filter((t) => t.status === "cancelled").length}。兼容叶子进度：
        {leaves.filter((t) => t.status === "completed").length}/
        {leaves.filter((t) => t.status !== "cancelled").length}。
      </p>
      <details>
        <summary>项目状态与归档</summary>
        <select
          aria-label="项目生命周期"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          {Object.entries(projectStatuses)
            .filter(([k]) => k !== "draft")
            .map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
        </select>
        <label>
          <input
            type="checkbox"
            checked={focused}
            onChange={(e) => setFocused(e.target.checked)}
          />
          关注（保留旧追踪选择）
        </label>
        <label>
          <input
            type="checkbox"
            checked={archive}
            onChange={(e) => setArchive(e.target.checked)}
          />
          归档
        </label>
        <p>
          未结束任务 {remaining.length}{" "}
          项。可先打开任务移动，或明确选择批量取消。
        </p>
        <label>
          <input
            type="checkbox"
            checked={cancel}
            onChange={(e) => setCancel(e.target.checked)}
          />
          结束项目时取消剩余任务
        </label>
        <button
          onClick={() =>
            confirm({
              action: {
                type: "project",
                id: p.id,
                expectedVersion: form.base.version,
                expectedPlanVersion: form.base.planVersion,
                status,
                archive,
                focused,
                cancelRemaining: cancel,
              },
              description: `项目 → ${projectStatuses[status]}${archive ? "，归档" : ""}。${["completed", "cancelled"].includes(status) ? `未结束任务 ${remaining.length} 项：${remaining.map((t) => t.title).join("、") || "无"}。${cancel ? "将批量取消，不会算作完成。" : "请先移动或处理；有剩余任务时执行将被阻止。"}` : "暂停保留安排与真实期限；重开将按所选项取消归档。"}`,
            })
          }
        >
          预览项目变更
        </button>
        {form.dirty && <button onClick={form.discard}>放弃项目修改</button>}
      </details>
      <details>
        <summary>管理分区</summary>
        <select
          aria-label="编辑分区"
          value={section}
          disabled={sectionForm.dirty}
          onChange={(e) => {
            setSection(e.target.value);
          }}
        >
          <option value="">新建分区</option>
          {data.sections
            .filter((s) => s.projectId === p.id)
            .map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
        </select>
        <input
          aria-label="分区名称"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <input
          aria-label="分区顺序"
          type="number"
          min={0}
          value={rank}
          onChange={(e) => setRank(Number(e.target.value))}
        />
        <button
          onClick={async () => {
            if (
              await save({
                type: "section",
                id: section || sectionId,
                projectId: p.id,
                name,
                rank,
                delete: false,
                expectedVersion: sectionForm.base.version,
              })
            ) {
              sectionForm.accept();
              setSection("");
              setSectionId(crypto.randomUUID());
            }
          }}
        >
          保存分区
        </button>
        {sectionForm.dirty && (
          <button onClick={sectionForm.discard}>放弃分区修改</button>
        )}
        {selected && (
          <button
            disabled={sectionForm.dirty}
            onClick={() =>
              confirm({
                action: {
                  type: "section",
                  id: selected.id,
                  projectId: p.id,
                  name: selected.name,
                  rank: selected.rank,
                  delete: true,
                  expectedVersion: selected.version,
                },
                description: `删除分区「${selected.name}」，${tasks.filter((t) => t.sectionId === selected.id).length} 项任务进入未分区，任务不删除。`,
              })
            }
          >
            删除分区
          </button>
        )}
      </details>
      {[null, ...data.sections.filter((s) => s.projectId === p.id)].map((s) => (
        <section key={s?.id ?? "none"}>
          <h3>{s?.name ?? "未分区"}</h3>
          {tasks
            .filter((t) => t.sectionId === (s?.id ?? null))
            .map((t) =>
              row(
                t,
                t.parentId
                  ? [
                      "子任务：" +
                        (data.tasks.find((p) => p.id === t.parentId)?.title ??
                          ""),
                    ]
                  : [],
              ),
            )}
        </section>
      ))}
    </section>
  );
}
