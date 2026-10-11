import { useLanRefresh } from "./useLanRefresh";
import { ProjectContextPanel } from "./ProjectContextPanel";
import { ProjectIcon } from "./ProjectIcon";
import { ProjectLifecycle } from "./ProjectLifecycle";
import { ProjectTaskList } from "./ProjectTaskList";
import { KanbanView } from "./KanbanView";
import { GanttView } from "./GanttView";
import { projectStates } from "@praxis/application";
import { projectTree } from "@praxis/application";
import { TaskActionMenu } from "./TaskActionMenu";
import { useCallback, useEffect, useRef, useState } from "react";
import { Projects, type Project, type ProjectTask } from "@praxis/application";
import { projectStorage } from "./storage";
export const projects = new Projects(projectStorage);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectsView({
  onDay,
  selectedId,
  onSelect: setSelectedId,
  onProjectsChanged,
  navigationRevision,
  onBusyChange,
  form,
  onFormChange: setForm,
  onSettings,
}: {
  onDay: (date: string) => void;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onProjectsChanged: () => void;
  navigationRevision: number;
  onBusyChange: (busy: boolean) => void;
  form: "new" | "edit" | null;
  onFormChange: (form: "new" | "edit" | null) => void;
  onSettings: () => void;
}) {
  const [mode, setMode] = useState<"tasks" | "gantt" | "board">("tasks");
  const [showCancelled, setShowCancelled] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const [contextBusy, setContextBusy] = useState(false);
  const [items, setItems] = useState<Project[]>([]),
    [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [titles, setTitles] = useState(""),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true);
  const taskInput = useRef<HTMLInputElement>(null);
  const focusAfterCapture = useRef(false);
  const [error, setError] = useState("");
  const locked = busy || viewBusy || contextBusy;
  useLanRefresh(
    () =>
      Promise.all([
        projectStorage.listProjects(),
        selectedId
          ? projectStorage.projectTasks(selectedId)
          : Promise.resolve([]),
      ]),
    ([next, rows]) => {
      setItems(next);
      setTasks(rows);
    },
    locked || form !== null || titles.length > 0,
    selectedId,
  );
  useEffect(() => {
    setTitles("");
  }, [navigationRevision]);
  useEffect(() => {
    onBusyChange(locked);
    return () => onBusyChange(false);
  }, [locked, onBusyChange]);
  useEffect(() => {
    if (!busy && focusAfterCapture.current) {
      focusAfterCapture.current = false;
      taskInput.current?.focus();
    }
  }, [busy]);
  const query = useRef(0);
  const selected = items.find((p) => p.id === selectedId);
  const tree = projectTree(tasks);
  const roots = tree.filter((t) => t.depth === 0);
  const total = roots.reduce((n, t) => n + t.leafTotal, 0);
  const done = roots.reduce((n, t) => n + t.leafDone, 0);
  const refresh = useCallback(
    async (id: string | null, reportFailure = false) => {
      const token = ++query.current;
      setLoading(true);
      try {
        const [next, rows] = await Promise.all([
          projectStorage.listProjects(),
          id ? projectStorage.projectTasks(id) : Promise.resolve([]),
        ]);
        if (token === query.current) {
          setItems(next);
          onProjectsChanged();
          setTasks(rows);
          setError("");
        }
      } catch (e) {
        if (token === query.current) setError(errorText(e));
        if (reportFailure) throw e;
      } finally {
        if (token === query.current) setLoading(false);
      }
    },
    [onProjectsChanged],
  );
  useEffect(() => {
    setTasks([]);
    void refresh(selectedId);
    const focus = () => void refresh(selectedId);
    window.addEventListener("focus", focus);
    return () => {
      query.current++;
      window.removeEventListener("focus", focus);
    };
  }, [selectedId, refresh]);
  async function run(action: () => Promise<void>) {
    if (locked || loading) return;
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
    <section
      className="today projects-view simple-project-workspace"
      aria-labelledby="projects-heading"
    >
      <div className="today-content">
        <h1 id="projects-heading" className="sr-only">
          项目
        </h1>
        {error && (
          <p role="alert" className="error">
            {error}{" "}
            <button disabled={busy} onClick={() => void refresh(selectedId)}>
              重新读取项目
            </button>
          </p>
        )}
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
                  await refresh(id);
                })
              }
            />
          )}
          {form === "edit" && selected && (
            <div className="project-settings-section">
              <h3>项目状态</h3>
              <ProjectLifecycle
                key={"lifecycle:" + selected.id}
                project={selected}
                onSaved={() => refresh(selected.id)}
              />
            </div>
          )}
          {!form && selected && (
            <>
              {(selected.status === "archived" || !!selected.archivedAt) && (
                <button className="project-back-button" onClick={onSettings}>
                  <ProjectIcon name="arrow" />
                  返回归档项目
                </button>
              )}
              <header className="project-summary">
                <div className="project-summary-main">
                  <div className="project-heading">
                    <span className="project-summary-icon">
                      <ProjectIcon name="folder" />
                    </span>
                    <h2>{selected.name}</h2>
                    {selected.status && selected.status !== "active" && (
                      <span
                        className="state-badge"
                        data-state={selected.status ?? "active"}
                      >
                        {projectStates[selected.status ?? "active"]}
                      </span>
                    )}
                  </div>
                  {selected.outcome && (
                    <p className="project-outcome">{selected.outcome}</p>
                  )}
                  {total > 0 && (
                    <p className="project-progress" aria-label="项目任务进度">
                      {done} / {total} 已完成
                    </p>
                  )}
                </div>
              </header>
              <ProjectContextPanel
                key={selected.id}
                projectId={selected.id}
                tasks={tasks}
                onBusyChange={setContextBusy}
                onSaved={() => refresh(selected.id, true)}
              />
              <div className="project-view-toolbar">
                <span className="project-section-label">任务</span>
                <div className="project-view-controls">
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
                        aria-label={label}
                        title={label}
                        key={key}
                        id={"project-view-" + key}
                        aria-controls="project-view-content"
                        disabled={locked}
                        tabIndex={mode === key ? 0 : -1}
                        aria-selected={mode === key}
                        onClick={() => setMode(key)}
                        onKeyDown={(event) => {
                          if (
                            locked ||
                            ![
                              "ArrowLeft",
                              "ArrowRight",
                              "Home",
                              "End",
                            ].includes(event.key)
                          )
                            return;
                          event.preventDefault();
                          const keys = ["tasks", "gantt", "board"] as const;
                          const index =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? 2
                                : (keys.indexOf(key) +
                                    (event.key === "ArrowRight" ? 1 : 2)) %
                                  3;
                          const next = keys[index]!;
                          setMode(next);
                          document
                            .getElementById("project-view-" + next)
                            ?.focus();
                        }}
                      >
                        <ProjectIcon name={key} />
                        <span>{key === "tasks" ? "列表" : label}</span>
                      </button>
                    ))}
                  </div>
                  <TaskActionMenu label="项目选项" disabled={locked}>
                    {(close) => (
                      <>
                        {mode === "tasks" &&
                          tasks.some((task) => task.status === "completed") && (
                            <button
                              aria-pressed={showCompleted}
                              onClick={() => {
                                setShowCompleted(!showCompleted);
                                close();
                              }}
                            >
                              {showCompleted
                                ? "隐藏已完成任务"
                                : "显示已完成任务"}
                            </button>
                          )}
                        {tasks.some((task) => task.status === "cancelled") && (
                          <button
                            aria-pressed={showCancelled}
                            onClick={() => {
                              setShowCancelled(!showCancelled);
                              close();
                            }}
                          >
                            {showCancelled
                              ? "隐藏已取消任务"
                              : "显示已取消任务"}
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setForm("edit");
                            close();
                          }}
                        >
                          编辑项目
                        </button>
                      </>
                    )}
                  </TaskActionMenu>
                </div>
              </div>
              <form
                className="project-task-form capture-form"
                aria-label="添加项目任务"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (locked || loading) return;
                  focusAfterCapture.current = true;
                  void run(async () => {
                    if (!titles.trim()) throw new Error("请填写任务标题");
                    await projects.add(selected.id, titles);
                    setTitles("");
                    await refresh(selected.id);
                  });
                }}
              >
                <span className="capture-circle" aria-hidden="true" />
                <label className="sr-only" htmlFor="project-tasks">
                  项目任务标题
                </label>
                <input
                  ref={taskInput}
                  id="project-tasks"
                  autoComplete="off"
                  value={titles}
                  disabled={locked || loading}
                  onChange={(event) => {
                    setTitles(event.target.value);
                    setError("");
                  }}
                  placeholder="添加项目任务，按回车保存"
                />
                {busy && (
                  <span className="capture-status" role="status">
                    保存中…
                  </span>
                )}
              </form>
              {loading && (
                <p className="project-loading" role="status">
                  正在读取任务…
                </p>
              )}
              <div
                id="project-view-content"
                role="tabpanel"
                aria-labelledby={"project-view-" + mode}
              >
                {mode === "gantt" && (
                  <GanttView
                    key={"gantt:" + selected.id}
                    project={selected}
                    tasks={tasks}
                    showCancelled={showCancelled}
                    disabled={busy || loading}
                    onBusyChange={setViewBusy}
                    onSaved={() => refresh(selected.id, true)}
                    onDay={onDay}
                  />
                )}
                {mode === "board" && (
                  <KanbanView
                    key={"board:" + selected.id}
                    tasks={tasks}
                    showCancelled={showCancelled}
                    disabled={busy || loading}
                    onBusyChange={setViewBusy}
                    onSaved={() => refresh(selected.id, true)}
                  />
                )}
                {mode === "tasks" && (
                  <ProjectTaskList
                    key={selected.id}
                    project={selected}
                    tasks={tasks}
                    busy={locked}
                    showCancelled={showCancelled}
                    showCompleted={showCompleted}
                    onRun={run}
                    onSaved={() => refresh(selected.id, true)}
                    onDay={onDay}
                  />
                )}
              </div>
              {mode === "tasks" && !loading && !tasks.length && (
                <p className="project-list-empty">
                  添加第一个任务，开始这个项目。
                </p>
              )}
            </>
          )}
          {!form && !selected && !loading && (
            <p className="empty-state">
              {items.length > 0
                ? "从左侧选择项目，查看下一步行动。"
                : "从左侧新建第一个项目。"}
            </p>
          )}
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
    [outcome, setOutcome] = useState(base?.outcome ?? "");
  return (
    <form
      className="task-editor project-form"
      aria-label="项目基本信息"
      onSubmit={(e) => {
        e.preventDefault();
        // Lifecycle edits can update the version while this name/outcome draft stays open.
        // Rebase only when the editable fields themselves are unchanged.
        const saveBase =
          snapshot &&
          base &&
          snapshot.id === base.id &&
          snapshot.name === base.name &&
          snapshot.outcome === base.outcome &&
          snapshot.targetDate === base.targetDate &&
          snapshot.priority === base.priority
            ? base
            : snapshot;
        void onSave(saveBase, {
          name,
          outcome,
          targetDate: snapshot?.targetDate ?? null,
          priority: snapshot?.priority ?? 1,
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
      <div className="project-actions">
        <button type="submit" disabled={disabled}>
          保存项目
        </button>
        <button type="button" disabled={disabled} onClick={onCancel}>
          取消
        </button>
      </div>
    </form>
  );
}
