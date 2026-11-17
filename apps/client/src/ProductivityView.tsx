import { feedbackMessage } from "./feedback-message";
import { useLanRefresh } from "./useLanRefresh";
import { prepareDailyTasks } from "./daily-preparation";
import { SyncedNotes } from "./SyncedNotes";
import { SubtaskComposer } from "./SubtaskComposer";
import { TrashView } from "./TrashView";
import { SearchViews } from "./SearchViews";
import { ReviewView } from "./ReviewView";
import { RepeatView } from "./RepeatView";
import { HabitsView } from "./HabitsView";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { DateStrip } from "./DateStrip";
import { upcomingDayRows } from "./day-timeline";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { DatePicker } from "./DatePicker";
import { shiftCalendarDate } from "./calendar-controls";
import { invoke } from "./native-recovery";
import { readPersonalWork } from "./personal-task-storage";
import {
  calendarDate,
  deadlineToLocal,
  deadlineFromLocal,
  dateAfter,
  dayRows,
  timeLabel,
  planConflict,
  subtree,
  terminal,
  type WorkSnapshot,
  type WorkTask,
  type WorkProject,
  type TimeValue,
} from "@praxis/application";
import { RetriableCommands } from "../../../packages/application/src/retriable-commands";
import { RelatedRecords } from "./RelatedRecords";
import "./productivity.css";
import "./task-editor.css";
type Action = Record<string, unknown> & { type: string };
type Command = { operationId: string; occurredAt: string; action: Action };
const retry = new RetriableCommands<Command>();
export const readWork = async () => {
  await prepareDailyTasks();
  return readPersonalWork();
};
export async function sendWorkAction(action: Action) {
  await prepareDailyTasks();
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
export interface TodayContent {
  data: WorkSnapshot;
  now: Date;
  zone: string;
  renderTask: (task: WorkTask, reasons?: string[]) => ReactNode;
}
export function ProductivityView({
  initialTab = "today",
  initialTaskId,
  initialProjectId,
  initialReviewId,
  searchRevision,
  onChanged,
  onBusyChange,
  renderToday,
  dailyNavigation,
  dailyDate,
  externalBusy = false,
  onTabChange,
  dailyRevision,
  onZoneChange,
  editorOnly = false,
  settingsOnly = false,
  onEditorClosed,
  onTaskCreated,
}: {
  initialTab?: "today" | "search" | "trash";
  initialTaskId?: string | null;
  initialProjectId?: string | null;
  initialReviewId?: string | null;
  searchRevision?: number;
  onChanged: () => void;
  onBusyChange: (v: boolean) => void;
  renderToday?: (content: TodayContent) => ReactNode;
  dailyNavigation?: ReactNode;
  dailyDate?: string;
  externalBusy?: boolean;
  onTabChange?: (tab: string) => void;
  dailyRevision?: string;
  onZoneChange?: (zone: string) => void;
  editorOnly?: boolean;
  settingsOnly?: boolean;
  onEditorClosed?: () => void;
  onTaskCreated?: (title: string, plan: TimeValue | null) => void;
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
  const [readFailure, setReadFailure] = useState("");
  const shownError = error || readFailure;
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
  const locked =
    busy || childBusy || !!edit || !!confirm || hasDraft || externalBusy;
  useEffect(() => {
    onTabChange?.(tab);
  }, [tab, onTabChange]);
  const automaticBlocked = useRef(false);
  automaticBlocked.current = locked;
  const readGeneration = useRef(0);
  useLanRefresh(readWork, setData, locked);
  const openedId = useRef<string | null>(null);
  useEffect(() => {
    if (!initialTaskId && !initialProjectId && !initialReviewId)
      setTab(initialTab);
  }, [
    initialTab,
    searchRevision,
    initialTaskId,
    initialProjectId,
    initialReviewId,
  ]);
  useEffect(() => {
    if (initialReviewId) setTab("review");
  }, [initialReviewId]);
  useEffect(() => {
    if (initialProjectId) {
      setProject(initialProjectId);
      setTab("projects");
    }
  }, [initialProjectId]);
  const refresh = async (automatic = false) => {
    const generation = ++readGeneration.current;
    try {
      const s = await readWork();
      if (generation === readGeneration.current && (!automatic || !automaticBlocked.current)) {
        setData(s);
        setReadFailure("");
      }
      return s;
    } catch (failure) {
      if (generation === readGeneration.current && (!automatic || !automaticBlocked.current)) setReadFailure(errorText(failure));
      throw failure;
    }
  };
  useEffect(() => {
    void refresh(true).catch(() => {});
  }, [tab]);
  useEffect(() => {
    if (dailyRevision !== undefined && !automaticBlocked.current)
      void refresh(true).catch(() => {});
  }, [dailyRevision, externalBusy]);
  useEffect(() => {
    void refresh(true).catch(() => {});
    const timer = setInterval(() => setClock(new Date()), 15000);
    const onFocus = () => {
      if (!automaticBlocked.current)
        void refresh(true).catch(() => {});
    };
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
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
      await sendWorkAction(action);
      await refresh().catch(() => setReadFailure("已保存，列表暂未更新。"));
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
  const zone =
      data?.settings[0]?.timeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    today = calendarDate(clock, zone),
    date = tab === "today" && dailyDate ? dailyDate : selectedDate || today;
  useEffect(() => {
    onZoneChange?.(zone);
  }, [zone, onZoneChange]);
  function changeStatus(t: WorkTask, status: string) {
    if (!data || locked) return;
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
        {renderToday && (
          <span className="work-row-icon">
            <TaskPanelIcon name={t.plan ? "clock" : "work"} />
          </span>
        )}
        <div>
          <button
            className="work-title"
            disabled={locked}
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
          {(t.plan || t.deadline || t.followUp) && (
            <small className="work-times">
              {t.plan && <span>计划 {timeLabel(t.plan, zone)}</span>}
              {t.deadline && <span>截止 {timeLabel(t.deadline, zone)}</span>}
              {t.followUp && <span>跟进 {timeLabel(t.followUp, zone)}</span>}
            </small>
          )}
          {t.status === "waiting" && (
            <p>
              等待 {t.waitingFor || "未指定对象"}：
              {t.waitingNote || "未填写说明"}
            </p>
          )}
        </div>
        <select
          disabled={locked}
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
  function closeEditor() {
    setEdit(null);
    onEditorClosed?.();
  }
  if (!data)
    return (
      <section className={editorOnly ? "work-overlay" : "work-view"}>
        <p role={shownError ? "alert" : "status"}>{shownError ? feedbackMessage(shownError) : "正在读取本地工作空间…"}</p>
        <button
          onClick={() => void refresh().catch(() => {})}
        >
          重新加载
        </button>
        {editorOnly && <button onClick={closeEditor}>关闭任务编辑</button>}
      </section>
    );
  const overlays = (
    <>
      {edit && (
        <div
          className={`work-overlay task-editor-overlay ${edit === "new" ? "quick-task-overlay" : "task-properties-overlay"}`}
          role="dialog"
          aria-modal="true"
          aria-label="任务属性"
        >
          <div>
            {shownError && <p role="alert">{feedbackMessage(shownError)}</p>}
            <TaskEditor
              key={edit === "new" ? "new" : edit.id}
              task={edit === "new" ? null : edit}
              initialPlan={
                renderToday && (tab === "today" || tab === "upcoming")
                  ? { kind: "date", date }
                  : null
              }
              onCreated={onTaskCreated}
              data={data}
              zone={zone}
              save={save}
              onSplitSaved={async () => {
                await refresh();
                onChanged();
                closeEditor();
              }}
              close={closeEditor}
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
            {shownError && <p role="alert">{feedbackMessage(shownError)}</p>}
            <p>{confirm.description}</p>
            <button
              disabled={busy}
              onClick={async () => {
                if (await save(confirm.action)) {
                  setConfirmedAction(confirm.action);
                  setConfirm(null);
                  closeEditor();
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
    </>
  );
  if (editorOnly) return overlays;
  if (settingsOnly)
    return (
      <div className="workspace-advanced-settings">
        {shownError && <p role="alert">{feedbackMessage(shownError)}</p>}
        <ZoneEditor data={data} save={save} onDirtyChange={setEditorDirty} />
        <LabelEditor data={data} save={save} onDirtyChange={setEditorDirty} />
      </div>
    );
  return (
    <section
      className={
        renderToday && (tab === "today" || tab === "upcoming")
          ? "today reference-day unified-timeline"
          : "work-view"
      }
    >
      <header className="page-heading">
        <h1
          className={
            renderToday && (tab === "today" || tab === "upcoming")
              ? "sr-only"
              : undefined
          }
        >
          {{
            all: "全部任务",
            projects: "项目与分区",
            settings: "时区与标签",
            repeat: "重复任务",
            habits: "习惯",
            trash: "回收站",
            search: "搜索与筛选",
            review: "项目回顾",
            notes: "策略与专注",
          }[tab] ?? "今日与近期"}
        </h1>
        {!renderToday && (
          <p className="page-description">
            聚焦重要的事，让每一步更清晰。
            <span className="workspace-zone">
              {data.settings[0]?.timeZone ?? "待确认"}
            </span>
          </p>
        )}
      </header>
      {shownError && <p role="alert">{feedbackMessage(shownError)}</p>}
      <fieldset
        className={renderToday ? "timeline-header" : undefined}
        disabled={locked}
      >
        <div className={renderToday ? "timeline-navigation" : undefined}>
          <nav
            className={renderToday ? "timeline-switcher" : "work-tabs"}
            aria-label="时间视图"
          >
            {[
              ["today", "今日"],
              ["upcoming", "近期"],
            ].map(([k, v]) => (
              <button
                key={k}
                aria-pressed={tab === k}
                onClick={() => setTab(k!)}
              >
                {v}
              </button>
            ))}
          </nav>
          {renderToday && tab === "today" && dailyNavigation}
          {renderToday && tab === "upcoming" && (
            <DateStrip
              date={date}
              today={today}
              onSelect={setDate}
              disabled={locked}
            />
          )}
        </div>
      </fieldset>
      {
        <>
          {!renderToday && (tab === "today" || tab === "upcoming") && (
            <label className="work-date-control">
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
          {tab === "today" &&
            renderToday &&
            renderToday({
              data,
              now: clock,
              zone,
              renderTask: row,
            })}
          {tab === "today" && !renderToday && (
            <>
              <div className="work-groups">
                {[0, 1, 2, 3].map((g) => {
                  const rows = dayRows(data, date, clock, zone).filter(
                    (r) => r.group === g,
                  );
                  return (
                    <section className="work-group" key={g}>
                      <div className="list-heading">
                        <h2>
                          {["截止事项", "每日重点", "当日安排", "到期跟进"][g]}{" "}
                          <span>{rows.length}</span>
                        </h2>
                      </div>
                      {rows.map((r) => row(r.task, r.reasons))}
                      {!rows.length && <p className="period-empty">暂无事项</p>}
                    </section>
                  );
                })}
              </div>
              {dayRows(data, date, clock, zone).length === 0 && (
                <p>这个日期暂无待处理事项。</p>
              )}
            </>
          )}
          {tab === "upcoming" && !renderToday && (
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
          {tab === "search" && <SearchViews key={searchRevision} />}
          {tab === "habits" && <HabitsView />}
          {tab === "trash" && (
            <TrashView
              onChanged={() => {
                void refresh().catch(() => {});
                onChanged();
              }}
            />
          )}
          {tab === "upcoming" && (
            <div className="timeline-upcoming">
              <label className="upcoming-range">
                查看未来{" "}
                <select
                  aria-label="近期范围"
                  value={days}
                  disabled={locked}
                  onChange={(e) => setDays(Number(e.target.value))}
                >
                  <option value={7}>7 天</option>
                  <option value={14}>14 天</option>
                  <option value={30}>30 天</option>
                </select>
              </label>
              {Array.from({ length: days }, (_, i) => dateAfter(date, i)).map(
                (d) => {
                  const rows = upcomingDayRows(data, d, zone);
                  return (
                    <section className="upcoming-day" data-date={d} key={d}>
                      <div className="list-heading">
                        <h2>
                          {d} <span>{rows.length}</span>
                        </h2>
                      </div>
                      {rows.map(({ task, reasons }) => row(task, reasons))}
                      {!rows.length && <p className="period-empty">暂无事项</p>}
                    </section>
                  );
                },
              )}
            </div>
          )}
          {tab === "all" && (
            <>
              {data.tasks.map((t) => row(t))}
              {!data.tasks.length && <p>还没有任务。</p>}
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
      }
      {overlays}
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
        <DatePicker
          label={label}
          value={value.date}
          onChange={(date) => onChange({ ...value, date })}
        />
      )}{" "}
      {value?.kind === "instant" && (
        <>
          <DatePicker
            label={`${label}（本地时间）`}
            mode="datetime"
            value={deadlineToLocal(value.atUtc)}
            onChange={(local) =>
              onChange({ ...value, atUtc: deadlineFromLocal(local)! })
            }
          />
          <small>本地时间输入 · {timeLabel(value, zone)}</small>
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
  initialPlan,
  onCreated,
}: {
  task: WorkTask | null;
  data: WorkSnapshot;
  zone: string;
  save: (a: Action) => Promise<boolean>;
  close: () => void;
  onSplitSaved: () => Promise<void>;
  confirm: (v: { action: Action; description: string }) => void;
  initialPlan?: TimeValue | null;
  onCreated?: ((title: string, plan: TimeValue | null) => void) | undefined;
}) {
  const [id] = useState(() => task?.id ?? crypto.randomUUID()),
    [title, setTitle] = useState(task?.title ?? ""),
    [notes, setNotes] = useState(task?.notes ?? ""),
    [plan, setPlan] = useState(task ? task.plan : (initialPlan ?? null)),
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
  const [expanded, setExpanded] = useState(!!task);
  const submitting = useRef(false);
  const editorRef = useRef<HTMLDivElement>(null);
  const originRef = useRef(document.activeElement as HTMLElement | null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const origin = originRef.current;
    const root = editorRef.current;
    const handler = (event: KeyboardEvent) => {
      if (document.querySelector(".date-picker-popover") || event.isComposing)
        return;
      if (event.key === "Escape" && !submitting.current) {
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
      }
      if (event.key !== "Tab" || !root) return;
      const controls = Array.from(
        root.querySelectorAll<HTMLElement>(
          'button,input,select,textarea,summary,[tabindex="0"]',
        ),
      ).filter((e) => e.getClientRects().length && !e.matches(":disabled"));
      const first = controls[0],
        last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handler);
    return () => {
      document.removeEventListener("keydown", handler);
      if (origin?.isConnected) origin.focus();
    };
  }, []);
  const quickToday = calendarDate(new Date(), zone);
  const action = {
    type: "task",
    id,
    ...(!task && plan ? { arrangeOnCreate: true } : {}),
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
    <div
      ref={editorRef}
      className={`work-dialog task-editor ${task ? "task-editor-existing" : "task-editor-quick"}`}
    >
      <header className="task-editor-heading">
        <h2>{task ? "任务详情" : "添加任务"}</h2>
        <button
          type="button"
          aria-label="关闭任务编辑"
          disabled={saving}
          onClick={close}
        >
          <TaskPanelIcon name="close" />
        </button>
      </header>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (submitting.current) return;
          if (planConflict({ plan, deadline }, zone) && !preview) {
            setPreview(true);
            return;
          }
          submitting.current = true;
          setSaving(true);
          try {
            if (await save(action)) {
              if (!task) onCreated?.(title.trim(), plan);
              close();
            }
          } finally {
            submitting.current = false;
            setSaving(false);
          }
        }}
        onKeyDown={(e) => {
          if (
            (e.ctrlKey || e.metaKey) &&
            e.key === "Enter" &&
            !e.nativeEvent.isComposing
          ) {
            e.preventDefault();
            e.currentTarget.requestSubmit();
            return;
          }
          if (e.key === "Enter" && e.nativeEvent.isComposing)
            e.preventDefault();
        }}
      >
        <fieldset disabled={saving}>
          <label>
            标题{" "}
            <input
              aria-label="任务标题"
              autoFocus
              placeholder="准备做什么？"
              value={title}
              onChange={(e) => {
                setTitle(e.target.value);
                setPreview(false);
              }}
              required
              maxLength={1000}
            />
          </label>
          {!task && (
            <>
              <div
                className="task-date-options quick-task-dates"
                aria-label="快速安排日期"
              >
                {[
                  [quickToday, "今天"],
                  [shiftCalendarDate(quickToday, 1), "明天"],
                  ["", "没有日期"],
                ].map(([date, caption]) => (
                  <button
                    key={caption}
                    type="button"
                    aria-pressed={
                      date ? plan?.kind === "date" && plan.date === date : !plan
                    }
                    onClick={() => {
                      setPlan(date ? { kind: "date", date } : null);
                      setPreview(false);
                    }}
                  >
                    {caption}
                  </button>
                ))}
                <DatePicker
                  label="快速任务日期"
                  value={plan?.kind === "date" ? plan.date : ""}
                  onChange={(date) => {
                    setPlan(date ? { kind: "date", date } : null);
                    setPreview(false);
                  }}
                />
              </div>
              <button
                type="button"
                className="quick-task-more"
                aria-expanded={expanded}
                onClick={() => setExpanded(!expanded)}
              >
                {expanded ? "收起选项" : "更多选项"}
              </button>
            </>
          )}
          <div className="task-editor-fields" hidden={!expanded}>
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
          </div>
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
          <div className="task-editor-actions">
            <span>
              {task
                ? "Ctrl + Enter 保存"
                : plan
                  ? `保存到 ${timeLabel(plan, zone)}`
                  : "保存到收件箱 · Enter 添加"}
            </span>
            <button type="submit" className="primary" disabled={!title.trim()}>
              {preview ? "确认保存" : task ? "保存修改" : "添加任务"}
            </button>
            <button type="button" onClick={close}>
              取消
            </button>
          </div>
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
      {invalid && <p role="alert">{feedbackMessage(invalid)}</p>}
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
