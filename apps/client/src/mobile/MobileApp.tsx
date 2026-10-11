import { useEffect, useRef, useState } from "react";
import type {
  WorkspaceEntity,
  WorkspaceSnapshot,
  WorkspaceCommand,
} from "@praxis/storage-mobile";
import { WorkspaceRejectedError } from "@praxis/storage-mobile";
import { calendarDate } from "@praxis/application";
import { App as NativeApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { mobileStorage } from "../../../../packages/storage-mobile/src/native";
import { Inbox } from "./Inbox";
import { Extras, type ExtraSection } from "./Extras";
import "./mobile.css";

const labels: Record<string, string> = {
  tasks: "任务清单",
  calendar: "日历",
  projects: "项目",
  stats: "完成统计",
  settings: "我的",
  inbox: "收件箱",
  habits: "习惯",
  repeat: "重复任务",
  records: "记录",
  review: "回顾",
  search: "搜索与视图",
  trash: "回收站",
  focus: "专注",
  templates: "策略与决策",
};
const text = (e: WorkspaceEntity, key: string) => String(e.data[key] ?? "");
function day(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function shifted(date: string, n: number) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + n);
  return day(d);
}
export function MobileApp() {
  const [snapshot, setSnapshot] = useState<WorkspaceSnapshot>({
    entities: [],
    pendingOperations: 0,
  });
  const [section, setSection] = useState("tasks"),
    [date, setDate] = useState(day()),
    [menu, setMenu] = useState(false),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [busy, setBusy] = useState(false),
    [childBusy, setChildBusy] = useState(false);
  const [editing, setEditing] = useState<WorkspaceEntity | null>(null),
    [expanded, setExpanded] = useState<string[]>([]),
    [projectFilter, setProjectFilter] = useState("");
  const saving = useRef(false);
  const pending = useRef<WorkspaceCommand | null>(null);
  const initializedDate = useRef(false),
    lastToday = useRef("");
  const refreshSequence = useRef(0);
  const [organizing, setOrganizing] = useState<"plan" | "section" | null>(null);
  const entities = snapshot.entities.filter((e) => !e.deleted),
    tasks = entities.filter((e) => e.kind === "task"),
    projects = entities.filter((e) => e.kind === "project");
  const timeZone = String(
    entities.find((e) => e.kind === "settings")?.data.timeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const today = calendarDate(new Date(), timeZone);
  async function refresh() {
    const sequence = ++refreshSequence.current;
    try {
      const next = await mobileStorage.workspaceSnapshot();
      if (sequence !== refreshSequence.current) return;
      const zone = String(
        next.entities.find((e) => e.kind === "settings" && !e.deleted)?.data
          .timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
      );
      const nextToday = calendarDate(new Date(), zone);
      const firstDate = !initializedDate.current,
        previousToday = lastToday.current;
      setDate((current) =>
        firstDate || current === previousToday ? nextToday : current,
      );
      initializedDate.current = true;
      lastToday.current = nextToday;
      setSnapshot(next);
      setError("");
    } catch (e) {
      if (sequence === refreshSequence.current)
        setError(e instanceof Error ? e.message : "本机数据读取失败");
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const f = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
  const backHandler = useRef(() => {});
  backHandler.current = () => {
    if (saving.current || pending.current) {
      setError("保存尚未确认，请先重试保存。");
      return;
    }
    const dialog =
      document.querySelector<HTMLDialogElement>(".pm-dialog[open]");
    if (dialog) {
      dialog.dispatchEvent(new Event("cancel", { cancelable: true }));
      return;
    }
    if (childBusy) {
      setError("请先保存或取消当前编辑，再返回。");
      return;
    }
    if (menu) {
      setMenu(false);
      return;
    }
    if (projectFilter) {
      setProjectFilter("");
      return;
    }
    if (section !== "tasks") {
      setSection("tasks");
      return;
    }
    void NativeApp.minimizeApp();
  };
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    const back = NativeApp.addListener("backButton", () =>
      backHandler.current(),
    );
    const active = NativeApp.addListener("appStateChange", ({ isActive }) => {
      if (isActive) void refresh();
    });
    return () => {
      void back.then((handle) => handle.remove());
      void active.then((handle) => handle.remove());
    };
  }, []);
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => {
      if (editing || childBusy || organizing || pending.current) {
        e.preventDefault();
      }
    };
    window.addEventListener("beforeunload", f);
    return () => window.removeEventListener("beforeunload", f);
  }, [editing, childBusy, organizing]);
  function canNavigate() {
    if (
      saving.current ||
      editing ||
      childBusy ||
      organizing ||
      pending.current
    ) {
      setError("请先保存或取消当前编辑，再切换页面。");
      return false;
    }
    return true;
  }
  function chooseDate(next: string) {
    if (canNavigate()) setDate(next);
  }
  function navigate(next: string) {
    if (!canNavigate()) return;
    setSection(next);
    setMenu(false);
    setProjectFilter("");
  }
  async function save(
    entity: WorkspaceEntity,
    data: Record<string, unknown>,
    deleted = false,
  ) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    try {
      const command: WorkspaceCommand = {
        operationId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        changes: [
          {
            id: entity.id,
            kind: entity.kind,
            expectedVersion: entity.version || null,
            data:
              entity.kind === "task" && entity.data.recurrenceId
                ? { ...data, manualModified: true }
                : data,
            deleted,
          },
        ],
      };
      const add = (target: WorkspaceEntity, patch: Record<string, unknown>) => {
        const existing = command.changes.find(
          (change) => change.id === target.id,
        );
        if (existing) {
          existing.data = { ...existing.data, ...patch };
          return;
        }
        command.changes.push({
          id: target.id,
          kind: target.kind,
          expectedVersion: target.version,
          data: { ...target.data, ...patch },
        });
      };
      const descendants: WorkspaceEntity[] = [];
      const collect = (id: string) => {
        for (const child of tasks.filter((t) => t.data.parentId === id)) {
          if (!descendants.some((t) => t.id === child.id)) {
            descendants.push(child);
            collect(child.id);
          }
        }
      };
      collect(entity.id);
      if (
        !deleted &&
        entity.kind === "task" &&
        !["completed", "cancelled"].includes(String(data.status))
      ) {
        const ancestors: WorkspaceEntity[] = [];
        let parent = tasks.find((t) => t.id === data.parentId);
        while (parent && !ancestors.some((t) => t.id === parent?.id)) {
          ancestors.push(parent);
          parent = tasks.find((t) => t.id === parent?.data.parentId);
        }
        const project = projects.find((p) => p.id === data.projectId);
        const closed = ancestors.filter((t) =>
          ["completed", "cancelled"].includes(text(t, "status")),
        );
        if (
          project &&
          (project.data.status !== "active" || project.data.archivedAt)
        )
          closed.push(project);
        if (closed.length) {
          if (
            !window.confirm(
              `重开此任务需要同时重开 ${closed.length} 个已结束的父任务或项目，是否继续？`,
            )
          )
            return;
          for (const item of closed)
            add(item, {
              status: item.kind === "project" ? "active" : "todo",
              archivedAt: null,
              completedAt: null,
            });
        }
      }
      if (
        !deleted &&
        data.status === "cancelled" &&
        entity.data.status !== "cancelled"
      ) {
        const affected = (
          entity.kind === "project"
            ? tasks.filter((t) => t.data.projectId === entity.id)
            : descendants
        ).filter(
          (t) => !["completed", "cancelled"].includes(text(t, "status")),
        );
        if (affected.length) {
          if (
            !window.confirm(
              `取消时将同时取消 ${affected.length} 个活动任务，是否继续？`,
            )
          )
            return;
          for (const child of affected)
            add(child, { status: "cancelled", completedAt: null });
        }
      }
      if (
        !deleted &&
        entity.kind === "task" &&
        (data.projectId !== entity.data.projectId ||
          data.sectionId !== entity.data.sectionId)
      ) {
        if (
          descendants.length &&
          !window.confirm(
            `移动时 ${descendants.length} 个子任务将继承相同项目和分区，是否继续？`,
          )
        )
          return;
        for (const child of descendants)
          add(child, {
            projectId: data.projectId ?? null,
            sectionId: data.sectionId ?? null,
          });
      }
      if (
        pending.current &&
        JSON.stringify(pending.current.changes) !==
          JSON.stringify(command.changes)
      )
        throw new Error("上次保存结果尚未确认，请先重试原内容，再继续修改。");
      pending.current ??= command;
      await mobileStorage.workspaceCommand(pending.current);
      pending.current = null;
      setEditing(null);
      setOrganizing(null);
      await refresh();
    } catch (e) {
      if (e instanceof WorkspaceRejectedError) pending.current = null;
      setError(
        e instanceof Error ? e.message : "保存失败，输入已保留，请重试。",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function retryPending() {
    if (saving.current || !pending.current) return;
    saving.current = true;
    setBusy(true);
    try {
      await mobileStorage.workspaceCommand(pending.current);
      pending.current = null;
      setEditing(null);
      setOrganizing(null);
      await refresh();
    } catch (e) {
      if (e instanceof WorkspaceRejectedError) pending.current = null;
      setError(e instanceof Error ? e.message : "重试失败，原操作仍保留。");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  function create(kind: "task" | "project", parent?: WorkspaceEntity) {
    if (!canNavigate()) return;
    setError("");
    setEditing({
      id: crypto.randomUUID(),
      kind,
      version: 0,
      deleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data:
        kind === "task"
          ? {
              title: "",
              status: "todo",
              executionDate: date,
              priority: 0,
              tags: [],
              parentId: parent?.id ?? null,
              projectId: parent?.data.projectId ?? (projectFilter || null),
            }
          : { title: "", status: "active" },
    });
  }
  const monday = shifted(
      date,
      -((new Date(`${date}T12:00:00`).getDay() + 6) % 7),
    ),
    days = Array.from({ length: 7 }, (_, i) => shifted(monday, i));
  const counts = days.map(
      (d) =>
        tasks.filter(
          (t) =>
            text(t, "status") === "completed" &&
            Boolean(t.data.completedAt) &&
            calendarDate(new Date(text(t, "completedAt")), timeZone) === d,
        ).length,
    ),
    max = Math.max(1, ...counts);
  const visible = tasks.filter(
    (t) =>
      (projectFilter
        ? text(t, "projectId") === projectFilter
        : text(t, "executionDate") === date || text(t, "dueDate") === date) &&
      text(t, "status") !== "cancelled",
  );
  const overdue = tasks.filter(
    (t) =>
      !["completed", "cancelled"].includes(text(t, "status")) &&
      ((text(t, "executionDate") && text(t, "executionDate") < date) ||
        (text(t, "dueDate") && text(t, "dueDate") < date)) &&
      !visible.some((v) => v.id === t.id),
  );
  function taskRow(t: WorkspaceEntity, depth = 0): React.ReactNode {
    const children = tasks.filter((c) => text(c, "parentId") === t.id),
      open = expanded.includes(t.id);
    return (
      <div
        className={`pm-task ${text(t, "status") === "completed" ? "is-complete" : ""}`}
        key={t.id}
        style={{ marginLeft: depth ? 16 : 0 }}
      >
        <div className="pm-task-line">
          <button
            className="pm-check"
            aria-label={`${text(t, "status") === "completed" ? "撤销完成" : "完成"}：${text(t, "title")}`}
            aria-pressed={text(t, "status") === "completed"}
            disabled={busy || Boolean(pending.current)}
            onClick={() =>
              void save(t, {
                ...t.data,
                status:
                  text(t, "status") === "completed" ? "todo" : "completed",
                completedAt:
                  text(t, "status") === "completed"
                    ? null
                    : new Date().toISOString(),
              })
            }
          >
            {text(t, "status") === "completed" ? "✓" : ""}
          </button>
          <button
            className="pm-task-title"
            disabled={busy || Boolean(pending.current)}
            onClick={() => {
              if (canNavigate()) {
                setError("");
                setEditing(t);
              }
            }}
          >
            <strong>{text(t, "title")}</strong>
            <span>
              {[
                t.data.priority ? `P${t.data.priority}` : "",
                t.data.waiting ? "等待跟进" : "",
                text(t, "dueDate") ? `截止 ${text(t, "dueDate")}` : "",
                projects.find((p) => p.id === t.data.projectId)?.data.title,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          </button>
          <button
            className="pm-icon"
            aria-label={`添加子任务：${text(t, "title")}`}
            onClick={() => create("task", t)}
          >
            ＋
          </button>
        </div>
        {children.length > 0 && (
          <button
            className="pm-expand"
            aria-expanded={open}
            onClick={() =>
              setExpanded(
                open
                  ? expanded.filter((id) => id !== t.id)
                  : [...expanded, t.id],
              )
            }
          >
            {open ? "⌃ 收起" : "⌄ 展开"} {children.length} 个子任务
          </button>
        )}
        {open && children.map((c) => taskRow(c, depth + 1))}
      </div>
    );
  }
  return (
    <div className="pm-app">
      <header className="pm-header">
        <div className="pm-top">
          <button
            aria-label="打开菜单"
            className="pm-icon"
            onClick={() => setMenu(!menu)}
          >
            ☰
          </button>
          <div>
            <small>PRAXIS · 把下一步变清晰</small>
            <h1>{labels[section]}</h1>
          </div>
          <button
            className="pm-icon"
            aria-label="打开收件箱"
            onClick={() => navigate("inbox")}
          >
            ▤
          </button>
        </div>
        {["tasks", "calendar"].includes(section) && (
          <>
            <div className="pm-week-title">
              <button
                aria-label="上一周"
                onClick={() => chooseDate(shifted(date, -7))}
              >
                ‹
              </button>
              <span>
                {new Date(`${date}T12:00:00`).toLocaleDateString("zh-CN", {
                  year: "numeric",
                  month: "long",
                })}
              </span>
              <button onClick={() => chooseDate(today)}>今天</button>
              <button
                aria-label="下一周"
                onClick={() => chooseDate(shifted(date, 7))}
              >
                ›
              </button>
            </div>
            <svg
              className="pm-trend"
              viewBox="0 0 350 44"
              role="img"
              aria-label={`本周每日完成任务数：${counts.join("、")}`}
            >
              <polyline
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                points={counts
                  .map((c, i) => `${25 + i * 50},${36 - (c / max) * 28}`)
                  .join(" ")}
              />
              {counts.map((c, i) => (
                <circle
                  key={i}
                  cx={25 + i * 50}
                  cy={36 - (c / max) * 28}
                  r="3"
                  fill="currentColor"
                />
              ))}
            </svg>
            <div className="pm-week">
              {days.map((d, i) => (
                <button
                  key={d}
                  className={d === date ? "selected" : ""}
                  aria-pressed={d === date}
                  onClick={() => chooseDate(d)}
                >
                  <small>{["一", "二", "三", "四", "五", "六", "日"][i]}</small>
                  <b>{Number(d.slice(-2))}</b>
                  <span>{counts[i] ? `${counts[i]} 完成` : "　"}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </header>
      {menu && (
        <nav className="pm-menu" aria-label="功能菜单">
          {Object.keys(labels).map((key) => (
            <button key={key} onClick={() => navigate(key)}>
              {labels[key]}
            </button>
          ))}
        </nav>
      )}
      {error && (
        <div className="pm-error" role="alert">
          {error}
          {pending.current && (
            <button disabled={busy} onClick={() => void retryPending()}>
              重试原操作
            </button>
          )}
          <button onClick={() => void refresh()}>重新读取</button>
        </div>
      )}
      <main className="pm-main">
        {loading ? (
          <p className="pm-empty">正在读取本机数据…</p>
        ) : (
          <>
            {["tasks", "calendar"].includes(section) && (
              <>
                {section === "calendar" && (
                  <label className="pm-date-picker">
                    跳转日期
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => chooseDate(e.target.value || today)}
                    />
                  </label>
                )}
                <div className="pm-list-heading">
                  <h2>
                    {date === day() ? "今天" : date}{" "}
                    <small>{visible.length} 项</small>
                  </h2>
                  <button onClick={() => setOrganizing("plan")}>
                    每日安排
                  </button>
                </div>
                {visible.length ? (
                  visible
                    .filter(
                      (t) => !visible.some((p) => p.id === t.data.parentId),
                    )
                    .map((t) => taskRow(t))
                ) : (
                  <div className="pm-empty">
                    <span>○</span>
                    <h2>给今天留一个明确的下一步</h2>
                    <p>点击右下角，添加任务或待办。</p>
                  </div>
                )}
                {section === "tasks" && overdue.length > 0 && (
                  <>
                    <div className="pm-list-heading">
                      <h2>
                        待重排 <small>{overdue.length} 项</small>
                      </h2>
                    </div>
                    {overdue
                      .filter(
                        (t) => !overdue.some((p) => p.id === t.data.parentId),
                      )
                      .map((t) => taskRow(t))}
                  </>
                )}
              </>
            )}
            {section === "projects" && (
              <>
                <div className="pm-list-heading">
                  <h2>
                    {projectFilter
                      ? String(
                          projects.find((p) => p.id === projectFilter)?.data
                            .title ?? "项目",
                        )
                      : "我的项目"}
                  </h2>
                  {projectFilter && (
                    <button onClick={() => setProjectFilter("")}>
                      全部项目
                    </button>
                  )}
                </div>
                {projectFilter ? (
                  <>
                    <button
                      className="pm-secondary"
                      onClick={() => setOrganizing("section")}
                    >
                      管理分区
                    </button>
                    {tasks
                      .filter(
                        (t) =>
                          text(t, "projectId") === projectFilter &&
                          !t.data.parentId,
                      )
                      .map((t) => taskRow(t))}
                    <button
                      className="pm-secondary"
                      onClick={() => create("task")}
                    >
                      ＋ 添加项目任务
                    </button>
                  </>
                ) : (
                  <>
                    {projects.map((p) => (
                      <article className="pm-project" key={p.id}>
                        <button onClick={() => setProjectFilter(p.id)}>
                          <span className="pm-project-symbol">▱</span>
                          <h2>{text(p, "title")}</h2>
                          <small>
                            {
                              (
                                {
                                  active: "进行中",
                                  completed: "已完成",
                                  cancelled: "已取消",
                                } as Record<string, string>
                              )[text(p, "status")]
                            }{" "}
                            {p.data.archivedAt ? " · 已归档 " : ""}·{" "}
                            {
                              tasks.filter(
                                (t) =>
                                  t.data.projectId === p.id &&
                                  t.data.status === "completed",
                              ).length
                            }
                            /
                            {
                              tasks.filter((t) => t.data.projectId === p.id)
                                .length
                            }{" "}
                            完成
                          </small>
                        </button>
                        {text(p, "recoveryNote") && (
                          <p>{text(p, "recoveryNote")}</p>
                        )}
                        <button
                          className="pm-secondary"
                          onClick={() => {
                            if (canNavigate()) {
                              setError("");
                              setEditing(p);
                            }
                          }}
                        >
                          编辑与恢复卡
                        </button>
                      </article>
                    ))}
                    {!projects.length && (
                      <p className="pm-empty">
                        还没有项目。点击 ＋ 创建第一个项目。
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            {section === "inbox" && (
              <Inbox
                snapshot={snapshot}
                refresh={refresh}
                onBusyChange={setChildBusy}
              />
            )}
            {!["tasks", "calendar", "projects", "inbox"].includes(section) && (
              <Extras
                section={section as ExtraSection}
                snapshot={snapshot}
                refresh={refresh}
                onBusyChange={setChildBusy}
              />
            )}
          </>
        )}
      </main>
      {["tasks", "calendar", "projects"].includes(section) && !editing && (
        <button
          className="pm-fab"
          aria-label={
            section === "projects" && !projectFilter ? "新建项目" : "新建任务"
          }
          onClick={() =>
            create(
              section === "projects" && !projectFilter ? "project" : "task",
            )
          }
        >
          ＋
        </button>
      )}
      <nav className="pm-bottom" aria-label="主导航">
        {[
          ["tasks", "☷", "清单"],
          ["calendar", "▦", "日历"],
          ["projects", "▱", "项目"],
          ["stats", "▥", "统计"],
          ["settings", "○", "我的"],
        ].map(([key, icon, label]) => (
          <button
            key={key}
            className={section === key ? "active" : ""}
            aria-current={section === key ? "page" : undefined}
            onClick={() => navigate(key!)}
          >
            <span aria-hidden="true">{icon}</span>
            {label}
          </button>
        ))}
      </nav>
      {editing && (
        <Editor
          key={editing.id}
          entity={editing}
          tasks={tasks}
          projects={projects}
          sections={entities.filter((e) => e.kind === "section")}
          busy={busy}
          error={error}
          onRetry={pending.current ? () => void retryPending() : undefined}
          onSave={(data, deleted) => void save(editing, data, deleted)}
          onClose={() => {
            if (!pending.current) setEditing(null);
            else setError("保存结果未确认，请先重试。");
          }}
        />
      )}
      {organizing && (
        <Organizer
          error={error}
          onRetry={pending.current ? () => void retryPending() : undefined}
          mode={organizing}
          date={date}
          projectId={projectFilter}
          entities={entities}
          busy={busy}
          onClose={() => {
            if (!pending.current) setOrganizing(null);
            else setError("保存结果未确认，请先重试。");
          }}
          onSave={(entity, data, deleted) => void save(entity, data, deleted)}
        />
      )}
    </div>
  );
}
function Organizer({
  mode,
  date,
  projectId,
  entities,
  busy,
  error,
  onRetry,
  onClose,
  onSave,
}: {
  mode: "plan" | "section";
  date: string;
  projectId: string;
  entities: WorkspaceEntity[];
  busy: boolean;
  error: string;
  onRetry: (() => void) | undefined;
  onClose: () => void;
  onSave: (
    entity: WorkspaceEntity,
    data: Record<string, unknown>,
    deleted?: boolean,
  ) => void;
}) {
  const existing =
    mode === "plan"
      ? entities.find((e) => e.kind === "plan" && e.data.date === date)
      : undefined;
  const [entity, setEntity] = useState<WorkspaceEntity>(
    existing ?? {
      id: crypto.randomUUID(),
      kind: mode,
      version: 0,
      deleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data:
        mode === "plan"
          ? { date, taskIds: [], outcome: "", note: "" }
          : { title: "", projectId },
    },
  );
  const [dirty, setDirty] = useState(false);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  function update(k: string, v: unknown) {
    setEntity({ ...entity, data: { ...entity.data, [k]: v } });
    setDirty(true);
  }
  function close() {
    if (!busy && (!dirty || window.confirm("放弃尚未保存的修改？"))) onClose();
  }
  return (
    <dialog
      ref={ref}
      className="pm-dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(entity, entity.data);
        }}
      >
        <div className="pm-dialog-top">
          <h2>{mode === "plan" ? `${date} · 每日安排` : "项目分区"}</h2>
          <button type="button" onClick={close}>
            ×
          </button>
        </div>
        {error && (
          <p role="alert" className="pm-error">
            {error}
            {onRetry && (
              <button type="button" disabled={busy} onClick={onRetry}>
                重试原操作
              </button>
            )}
          </p>
        )}
        {mode === "section" ? (
          <>
            <label>
              选择分区
              <select
                value={entity.version ? entity.id : ""}
                onChange={(e) => {
                  const found = entities.find((s) => s.id === e.target.value);
                  if (found) {
                    setEntity(found);
                    setDirty(false);
                  } else
                    setEntity({
                      ...entity,
                      id: crypto.randomUUID(),
                      version: 0,
                      data: { title: "", projectId },
                    });
                }}
              >
                <option value="">新建分区</option>
                {entities
                  .filter(
                    (s) =>
                      s.kind === "section" && s.data.projectId === projectId,
                  )
                  .map((s) => (
                    <option value={s.id} key={s.id}>
                      {text(s, "title")}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              分区名称
              <input
                required
                value={text(entity, "title")}
                onChange={(e) => update("title", e.target.value)}
              />
            </label>
            {entity.version > 0 && (
              <button
                type="button"
                className="pm-delete"
                onClick={() => {
                  if (window.confirm("删除分区？请先把任务移到其他分区。"))
                    onSave(entity, entity.data, true);
                }}
              >
                移到回收站
              </button>
            )}
          </>
        ) : (
          <>
            <label>
              今天希望取得的结果
              <textarea
                rows={3}
                value={text(entity, "outcome")}
                onChange={(e) => update("outcome", e.target.value)}
              />
            </label>
            <fieldset>
              <legend>重点任务</legend>
              {entities
                .filter(
                  (t) =>
                    t.kind === "task" &&
                    !["completed", "cancelled"].includes(text(t, "status")),
                )
                .map((t) => (
                  <label className="pm-checkbox" key={t.id}>
                    <input
                      type="checkbox"
                      checked={
                        Array.isArray(entity.data.taskIds) &&
                        entity.data.taskIds.includes(t.id)
                      }
                      onChange={(e) => {
                        const ids = Array.isArray(entity.data.taskIds)
                          ? entity.data.taskIds
                          : [];
                        update(
                          "taskIds",
                          e.target.checked
                            ? [...ids, t.id]
                            : ids.filter((id) => id !== t.id),
                        );
                      }}
                    />
                    {text(t, "title")}
                  </label>
                ))}
            </fieldset>
            <label>
              收尾备注
              <textarea
                rows={3}
                value={text(entity, "note")}
                onChange={(e) => update("note", e.target.value)}
              />
            </label>
          </>
        )}
        <div className="pm-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button className="pm-primary" disabled={busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
function Editor({
  entity,
  tasks,
  projects,
  sections,
  busy,
  error,
  onRetry,
  onSave,
  onClose,
}: {
  entity: WorkspaceEntity;
  tasks: WorkspaceEntity[];
  projects: WorkspaceEntity[];
  sections: WorkspaceEntity[];
  busy: boolean;
  error: string;
  onRetry: (() => void) | undefined;
  onSave: (data: Record<string, unknown>, deleted?: boolean) => void;
  onClose: () => void;
}) {
  const [data, setData] = useState(entity.data),
    [dirty, setDirty] = useState(false);
  const [tagInput, setTagInput] = useState(
    Array.isArray(entity.data.tags) ? entity.data.tags.join(", ") : "",
  );
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  function update(key: string, value: unknown) {
    setData({ ...data, [key]: value });
    setDirty(true);
  }
  function close() {
    if (!busy && (!dirty || window.confirm("放弃尚未保存的修改？"))) onClose();
  }
  const field = (key: string) => String(data[key] ?? "");
  return (
    <dialog
      ref={ref}
      className="pm-dialog"
      onCancel={(e) => {
        e.preventDefault();
        close();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSave(
            entity.kind === "task"
              ? {
                  ...data,
                  tags: tagInput
                    .split(/[,，]/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                }
              : data,
          );
        }}
      >
        <div className="pm-dialog-top">
          <h2>
            {entity.version ? "编辑" : "新建"}
            {entity.kind === "task" ? "任务" : "项目"}
          </h2>
          <button
            type="button"
            onClick={close}
            disabled={busy}
            aria-label="关闭编辑"
          >
            ×
          </button>
        </div>
        {error && (
          <p role="alert" className="pm-error">
            {error}
            {onRetry && (
              <button type="button" disabled={busy} onClick={onRetry}>
                重试原操作
              </button>
            )}
          </p>
        )}
        <label>
          名称
          <input
            autoFocus
            required
            value={field("title")}
            onChange={(e) => update("title", e.target.value)}
          />
        </label>
        <label>
          状态
          <select
            value={field("status")}
            onChange={(e) => update("status", e.target.value)}
          >
            {(entity.kind === "task"
              ? [
                  ["todo", "待办"],
                  ["in_progress", "进行中"],
                  ["blocked", "受阻"],
                  ["completed", "已完成"],
                  ["cancelled", "已取消"],
                ]
              : [
                  ["active", "进行中"],
                  ["completed", "完成"],
                  ["cancelled", "取消"],
                ]
            ).map(([v, l]) => (
              <option value={v} key={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {entity.kind === "task" ? (
          <>
            <label>
              项目
              <select
                value={field("projectId")}
                onChange={(e) => {
                  setData({
                    ...data,
                    projectId: e.target.value || null,
                    parentId: null,
                    sectionId: null,
                  });
                  setDirty(true);
                }}
              >
                <option value="">独立任务</option>
                {projects
                  .filter(
                    (p) =>
                      p.data.status === "active" || p.id === data.projectId,
                  )
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {text(p, "title")}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              父任务
              <select
                value={field("parentId")}
                onChange={(e) => {
                  const parent = tasks.find((t) => t.id === e.target.value);
                  setData({
                    ...data,
                    parentId: parent?.id ?? null,
                    sectionId: parent?.data.sectionId ?? data.sectionId ?? null,
                  });
                  setDirty(true);
                }}
              >
                <option value="">顶层任务</option>
                {tasks
                  .filter(
                    (t) =>
                      t.id !== entity.id &&
                      (t.data.projectId || null) === (data.projectId || null),
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {text(t, "title")}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              分区
              <select
                value={field("sectionId")}
                disabled={Boolean(data.parentId)}
                onChange={(e) => update("sectionId", e.target.value || null)}
              >
                <option value="">未分区</option>
                {sections
                  .filter((s) => s.data.projectId === data.projectId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {text(s, "title")}
                    </option>
                  ))}
              </select>
            </label>
            <div className="pm-form-grid">
              {[
                ["executionDate", "安排日期"],
                ["startDate", "开始日期"],
                ["dueDate", "真实期限"],
                ["followUpDate", "跟进日期"],
              ].map(([key, label]) => (
                <label key={key}>
                  {label}
                  <input
                    type="date"
                    value={field(key!)}
                    onChange={(e) => update(key!, e.target.value || null)}
                  />
                </label>
              ))}
            </div>
            {field("executionDate") &&
              field("dueDate") &&
              field("executionDate") > field("dueDate") && (
                <p role="status">安排日期晚于真实期限，请确认是否需要调整。</p>
              )}
            <label>
              优先级
              <select
                value={Number(data.priority ?? 0)}
                onChange={(e) => update("priority", Number(e.target.value))}
              >
                <option value={0}>P4 · 普通</option>
                <option value={1}>P1 · 高</option>
                <option value={2}>P2 · 中</option>
                <option value={3}>P3 · 低</option>
              </select>
            </label>
            <label>
              标签（逗号分隔）
              <input
                value={tagInput}
                onChange={(e) => {
                  setTagInput(e.target.value);
                  setDirty(true);
                }}
              />
            </label>
            <label className="pm-checkbox">
              <input
                type="checkbox"
                checked={Boolean(data.waiting)}
                onChange={(e) => update("waiting", e.target.checked)}
              />
              等待他人 / 等待跟进
            </label>
            {Boolean(data.waiting) && (
              <>
                <label>
                  等待对象
                  <input
                    value={field("waitingFor")}
                    onChange={(e) => update("waitingFor", e.target.value)}
                  />
                </label>
                <label>
                  等待原因
                  <input
                    value={field("waitingReason")}
                    onChange={(e) => update("waitingReason", e.target.value)}
                  />
                </label>
              </>
            )}
            <label>
              备注
              <textarea
                rows={3}
                value={field("notes")}
                onChange={(e) => update("notes", e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <label className="pm-checkbox">
              <input
                type="checkbox"
                checked={Boolean(data.archivedAt)}
                disabled={
                  !["completed", "cancelled"].includes(String(data.status))
                }
                onChange={(e) =>
                  update(
                    "archivedAt",
                    e.target.checked ? new Date().toISOString() : null,
                  )
                }
              />
              归档已结束项目
            </label>
            <label>
              完成标准
              <textarea
                rows={2}
                value={field("completionCriteria")}
                onChange={(e) => update("completionCriteria", e.target.value)}
              />
            </label>
            <label>
              主要阻塞
              <textarea
                rows={2}
                value={field("blocker")}
                onChange={(e) => update("blocker", e.target.value)}
              />
            </label>
            <label>
              复查日期
              <input
                type="date"
                value={field("reviewDate")}
                onChange={(e) => update("reviewDate", e.target.value || null)}
              />
            </label>
            <label>
              恢复卡 · 下次从哪里继续
              <textarea
                rows={4}
                value={field("recoveryNote")}
                onChange={(e) => update("recoveryNote", e.target.value)}
              />
            </label>
            <label>
              下一步
              <select
                value={field("nextActionId")}
                onChange={(e) => update("nextActionId", e.target.value || null)}
              >
                <option value="">暂不指定</option>
                {tasks
                  .filter(
                    (t) =>
                      t.data.projectId === entity.id &&
                      !["completed", "cancelled"].includes(
                        String(t.data.status),
                      ),
                  )
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {text(t, "title")}
                    </option>
                  ))}
              </select>
            </label>
          </>
        )}
        <div className="pm-dialog-actions">
          <button type="button" disabled={busy} onClick={close}>
            取消
          </button>
          <button
            className="pm-primary"
            disabled={busy || !field("title").trim()}
          >
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
        {entity.version > 0 && (
          <button
            className="pm-delete"
            type="button"
            disabled={busy}
            onClick={() => {
              const descendants = new Set<string>();
              function collect(id: string) {
                for (const child of tasks.filter(
                  (t) => t.data.parentId === id,
                )) {
                  if (!descendants.has(child.id)) {
                    descendants.add(child.id);
                    collect(child.id);
                  }
                }
              }
              collect(entity.id);
              const impact =
                entity.kind === "project"
                  ? `将同时处理 ${tasks.filter((t) => t.data.projectId === entity.id).length} 个关联任务和 ${sections.filter((s) => s.data.projectId === entity.id).length} 个分区。`
                  : `将同时处理 ${descendants.size} 个子任务。`;
              if (
                window.confirm(
                  `将“${field("title")}”移到回收站？${impact}恢复时会一并处理关联内容。`,
                )
              )
                onSave(data, true);
            }}
          >
            移到回收站
          </button>
        )}
      </form>
    </dialog>
  );
}
