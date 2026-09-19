import { ProjectLifecycle } from "./ProjectLifecycle";
import { TaskMoveControls } from "./TaskMoveControls";
import { KanbanView } from "./KanbanView";
import { GanttView } from "./GanttView";
import { taskStates, projectStates } from "@praxis/application";
import { SubtaskComposer } from "./SubtaskComposer";
import { projectTree } from "@praxis/application";
import { TaskDetailsButton } from "./TaskDetailsButton";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Projects,
  calendarDate,
  type Project,
  type ProjectTask,
} from "@praxis/application";
import { projectStorage } from "./storage";
import { planning } from "./PlanningPanel";
export const projects = new Projects(projectStorage);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectsView({ onDay }: { onDay: (date: string) => void }) {
  const [mode, setMode] = useState<"tasks" | "gantt" | "board">("tasks");
  const [filter, setFilter] = useState("all"),
    [showCancelled, setShowCancelled] = useState(false);
  const [items, setItems] = useState<Project[]>([]),
    [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [form, setForm] = useState<"new" | "edit" | null>(null);
  const [titles, setTitles] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const query = useRef(0);
  const selected = items.find((p) => p.id === selectedId);
  const tree = projectTree(tasks);
  const roots = tree.filter((t) => t.depth === 0);
  const total = roots.reduce((n, t) => n + t.leafTotal, 0);
  const done = roots.reduce((n, t) => n + t.leafDone, 0);
  const refresh = useCallback(async (id: string | null) => {
    const token = ++query.current;
    setLoading(true);
    try {
      const [next, rows] = await Promise.all([
        projectStorage.listProjects(),
        id ? projectStorage.projectTasks(id) : Promise.resolve([]),
      ]);
      if (token === query.current) {
        setItems(next);
        setTasks(rows);
        setError("");
      }
    } catch (e) {
      if (token === query.current) setError(errorText(e));
    } finally {
      if (token === query.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh(selectedId);
    const focus = () => void refresh(selectedId);
    window.addEventListener("focus", focus);
    return () => {
      query.current++;
      window.removeEventListener("focus", focus);
    };
  }, [selectedId, refresh]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="today projects-view" aria-labelledby="projects-heading">
      <header className="topbar">
        我的工作台 / 项目<span className="local-badge">保存在本机</span>
      </header>
      <div className="today-content">
        <p className="eyebrow">MAKE ROOM FOR MEANINGFUL WORK</p>
        <h1 id="projects-heading">让想法有一个去处。</h1>
        <p className="intro">写下期待的结果，再拆成可以行动的小步。</p>
        <button
          disabled={busy}
          onClick={() => {
            setForm("new");
            setNotice("");
          }}
        >
          新建项目
        </button>
        {error && (
          <p role="alert" className="error">
            {error}{" "}
            <button disabled={busy} onClick={() => void refresh(selectedId)}>
              重新读取项目
            </button>
          </p>
        )}
        <p className="save-notice" role="status">
          {notice}
        </p>
        <div className="project-filters" aria-label="项目筛选">
          {(
            [
              ["all", "全部项目"],
              ["focused", "重点项目"],
              ["archived", "归档项目"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="project-layout">
          <nav className="project-list" aria-label="项目列表">
            {items
              .filter((p) =>
                filter === "archived"
                  ? p.status === "archived"
                  : filter === "focused"
                    ? p.focused && p.status !== "archived"
                    : p.status !== "archived",
              )
              .map((p) => (
                <button
                  key={p.id}
                  disabled={busy}
                  className={
                    p.id === selectedId
                      ? "project-card selected"
                      : "project-card"
                  }
                  onClick={() => {
                    if (p.id !== selectedId) setTasks([]);
                    setSelectedId(p.id);
                    setForm(null);
                    setTitles("");
                    setNotice("");
                  }}
                >
                  <strong>{p.name}</strong>
                  <small>
                    {projectStates[p.status ?? "active"]}
                    {p.focused ? " · 重点" : ""}
                  </small>
                  <span>{p.outcome || "尚未填写预期结果"}</span>
                  <small>
                    {["低", "普通", "高"][p.priority]}优先级 ·{" "}
                    {p.targetDate ?? "未设目标日期"}
                  </small>
                </button>
              ))}
            {!items.length && !loading && (
              <p className="empty-state">从第一个项目开始。</p>
            )}
          </nav>
          <div className="project-body">
            {form && (
              <ProjectForm
                key={form === "new" ? "new" : selected?.id}
                base={form === "edit" ? (selected ?? null) : null}
                disabled={busy}
                onCancel={() => setForm(null)}
                onSave={(base, fields) =>
                  run(async () => {
                    const id = await projects.save(base, fields);
                    setSelectedId(id);
                    setForm(null);
                    setNotice("项目已保存到本机");
                    await refresh(id);
                  })
                }
              />
            )}
            {!form && selected && (
              <>
                <div className="project-heading">
                  <h2>{selected.name}</h2>
                  <button disabled={busy} onClick={() => setForm("edit")}>
                    编辑项目
                  </button>
                </div>
                <p className="project-outcome">
                  {selected.outcome || "可以编辑项目，补充预期结果。"}
                </p>
                <p className="task-meta">
                  目标日期：{selected.targetDate ?? "未设置"} ·{" "}
                  {["低", "普通", "高"][selected.priority]}优先级
                </p>
                <p className="project-progress">
                  叶子任务进度：{done} / {total} 已完成
                </p>
                <ProjectLifecycle
                  key={selected.id}
                  project={selected}
                  onSaved={() => refresh(selected.id)}
                />
                <div
                  className="project-view-tabs"
                  role="tablist"
                  aria-label="项目视图"
                >
                  {(
                    [
                      ["tasks", "任务视图"],
                      ["gantt", "甘特图"],
                      ["board", "看板"],
                    ] as const
                  ).map(([key, label]) => (
                    <button
                      role="tab"
                      key={key}
                      aria-selected={mode === key}
                      onClick={() => setMode(key)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {mode === "gantt" && (
                  <GanttView
                    key={selected.id}
                    project={selected}
                    tasks={tasks}
                    onSaved={() => refresh(selected.id)}
                    onDay={onDay}
                  />
                )}
                {mode === "board" && (
                  <KanbanView
                    key={selected.id}
                    tasks={tasks}
                    onSaved={() => refresh(selected.id)}
                  />
                )}
                {mode === "tasks" && (
                  <>
                    <form
                      className="project-task-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          await projects.add(selected.id, titles);
                          setTitles("");
                          setNotice("项目任务已保存");
                          await refresh(selected.id);
                        });
                      }}
                    >
                      <label htmlFor="project-tasks">拆成可以行动的任务</label>
                      <textarea
                        id="project-tasks"
                        value={titles}
                        disabled={busy}
                        onChange={(e) => setTitles(e.target.value)}
                        placeholder="每行一条任务，暂时不必安排日期"
                        rows={3}
                      />
                      <button disabled={busy}>添加项目任务</button>
                    </form>
                    {loading && <p>正在读取任务…</p>}
                    <>
                      <label>
                        <input
                          type="checkbox"
                          checked={showCancelled}
                          onChange={(e) => setShowCancelled(e.target.checked)}
                        />
                        显示已取消任务
                      </label>
                      <ul className="task-list project-tasks">
                        {tree
                          .filter(
                            (t) => showCancelled || t.status !== "cancelled",
                          )
                          .map((task) => (
                            <li
                              className="inbox-row tree-task"
                              key={task.taskId}
                              style={{
                                marginLeft: Math.min(task.depth, 8) * 18,
                              }}
                            >
                              <div>
                                <strong>
                                  {task.important && (
                                    <span className="task-important">重要</span>
                                  )}
                                  {task.title}
                                </strong>
                                <p className="task-meta">
                                  {task.hasChildren
                                    ? `汇总 · ${task.leafDone} / ${task.leafTotal} 已完成`
                                    : (taskStates[task.status] ??
                                      task.status)}{" "}
                                  ·{" "}
                                  {task.completionDate ??
                                    task.executionDate ??
                                    "尚未安排"}
                                  {task.statusReason &&
                                    " · " + task.statusReason}
                                </p>
                              </div>
                              <TaskDetailsButton
                                taskId={task.taskId}
                                onSaved={() => refresh(selected.id)}
                                disabled={busy}
                              />
                              {task.hasChildren ? (
                                <span className="task-meta">
                                  {task.hasSummaryPlan
                                    ? "原安排已转为汇总记录"
                                    : "仅执行叶子任务"}
                                </span>
                              ) : task.executionDate ? (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    onDay(
                                      task.completionDate ??
                                        task.executionDate!,
                                    )
                                  }
                                >
                                  {task.status === "completed"
                                    ? "查看完成记录"
                                    : "查看安排"}
                                </button>
                              ) : ["todo", "in_progress", "blocked"].includes(
                                  task.status,
                                ) ? (
                                <button
                                  disabled={busy}
                                  onClick={() =>
                                    void run(async () => {
                                      const zone =
                                        Intl.DateTimeFormat().resolvedOptions()
                                          .timeZone;
                                      const date = calendarDate(
                                        new Date(),
                                        zone,
                                      );
                                      await planning.schedule(task, date, zone);
                                      setNotice("已加入今日，仍是同一条任务");
                                      await refresh(selected.id);
                                    })
                                  }
                                >
                                  加入今日
                                </button>
                              ) : null}
                              <TaskMoveControls
                                task={task}
                                tasks={tasks}
                                project={selected}
                                onSaved={() => refresh(selected.id)}
                              />
                              <SubtaskComposer
                                task={task}
                                onSaved={() => refresh(selected.id)}
                              />
                            </li>
                          ))}
                      </ul>
                    </>
                  </>
                )}
                {!loading && !tasks.length && (
                  <p className="empty-state">项目还没有任务，先写下下一步。</p>
                )}
              </>
            )}
            {!form && !selected && items.length > 0 && (
              <p className="empty-state">选择项目，查看下一步行动。</p>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}
function ProjectForm({
  base,
  disabled,
  onCancel,
  onSave,
}: {
  base: Project | null;
  disabled: boolean;
  onCancel: () => void;
  onSave: (
    base: Project | null,
    fields: import("@praxis/application").ProjectFields,
  ) => Promise<void>;
}) {
  const [snapshot] = useState(base);
  const [name, setName] = useState(base?.name ?? ""),
    [outcome, setOutcome] = useState(base?.outcome ?? ""),
    [date, setDate] = useState(base?.targetDate ?? ""),
    [priority, setPriority] = useState(base?.priority ?? 1);
  return (
    <form
      className="task-editor project-form"
      aria-label="项目基本信息"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave(snapshot, {
          name,
          outcome,
          targetDate: date || null,
          priority,
        });
      }}
    >
      <h2>{base ? "编辑项目" : "新建项目"}</h2>
      <label htmlFor="project-name">项目名称</label>
      <input
        id="project-name"
        value={name}
        disabled={disabled}
        onChange={(e) => setName(e.target.value)}
      />
      <label htmlFor="project-outcome">预期结果</label>
      <textarea
        id="project-outcome"
        value={outcome}
        disabled={disabled}
        onChange={(e) => setOutcome(e.target.value)}
        rows={3}
      />
      <label htmlFor="project-date">目标日期（可选）</label>
      <input
        id="project-date"
        type="date"
        value={date}
        disabled={disabled}
        onChange={(e) => setDate(e.target.value)}
      />
      <label htmlFor="project-priority">项目优先级</label>
      <select
        id="project-priority"
        value={priority}
        disabled={disabled}
        onChange={(e) => setPriority(Number(e.target.value))}
      >
        <option value={0}>低</option>
        <option value={1}>普通</option>
        <option value={2}>高</option>
      </select>
      <div className="project-actions">
        <button disabled={disabled}>保存项目</button>
        <button type="button" disabled={disabled} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
