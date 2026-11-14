import { PersonalTodoHome } from "./PersonalTodoHome";
import { PersonalProjectForm } from "./PersonalProjectForm";
import { PersonalProjectList, PersonalProjectProgress } from "./PersonalProjectList";
import { desktopProjectSave } from "./personal-project-storage";
import { personalTasks } from "./personal-task-storage";
import type { WorkSnapshot } from "@praxis/application";
import { useLanRefresh } from "./useLanRefresh";
import { ProjectIcon } from "./ProjectIcon";
import { KanbanView } from "./KanbanView";
import { projectStates } from "@praxis/application";
import { TaskActionMenu } from "./TaskActionMenu";
import { useCallback, useEffect, useRef, useState } from "react";
import { Projects, type Project, type ProjectTask } from "@praxis/application";
import { projectStorage } from "./storage";
import { ProjectTaskPanel } from "./ProjectTaskPanel";
import { ProjectTaskPanelContext } from "./project-task-panel-context";
export const projects = new Projects(projectStorage);
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function ProjectsView({
  selectedId,
  onSelect: setSelectedId,
  onProjectsChanged,
  navigationRevision,
  onBusyChange,
  form,
  onFormChange: setForm,
  onSettings,
  onOpenPersonalAgent,
}: {
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onProjectsChanged: () => void;
  navigationRevision: number;
  onBusyChange: (busy: boolean) => void;
  form: "new" | "edit" | null;
  onFormChange: (form: "new" | "edit" | null) => void;
  onSettings: () => void;
  onOpenPersonalAgent?: (mode:"decompose"|"next",projectId:string)=>void;
}) {
  const [work, setWork] = useState<WorkSnapshot | null>(null);
  const [formLocked, setFormLocked] = useState(false);
  const [mode, setMode] = useState<"tasks" | "board">("tasks");
  const [showCancelled, setShowCancelled] = useState(false);
  const [taskBusy, setTaskBusy] = useState(false);
  const [viewBusy, setViewBusy] = useState(false);
  const [panelTaskId, setPanelTaskId] = useState<string | null>(null);
  const [panelLocked, setPanelLocked] = useState(false);
  const [panelRevision, setPanelRevision] = useState(0);
  const panelFlush = useRef<() => Promise<boolean>>(() =>
    Promise.resolve(true),
  );
  const panelTrigger = useRef<HTMLButtonElement | null>(null);
  const panelRequest = useRef(0);
  const [items, setItems] = useState<Project[]>([]),
    [tasks, setTasks] = useState<ProjectTask[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const locked = taskBusy || formLocked || viewBusy || panelLocked;
  useEffect(() => {
    panelRequest.current++;
    setPanelTaskId(null);
    setPanelLocked(false);
    panelFlush.current = () => Promise.resolve(true);
  }, [selectedId, navigationRevision, form]);
  useLanRefresh(
    () =>
      Promise.all([
        projectStorage.listProjects(),
        selectedId
          ? projectStorage.projectTasks(selectedId)
          : Promise.resolve([]),
        personalTasks.read(),
      ]),
    ([next, rows, personal]) => {
      setWork(personal.work);
      setItems(next);
      setTasks(rows);
    },
    locked || form !== null,
    selectedId,
  );
  useEffect(() => {
    onBusyChange(locked);
    return () => onBusyChange(false);
  }, [locked, onBusyChange]);
  const query = useRef(0);
  const selected = items.find((p) => p.id === selectedId);
  const panelTask = tasks.find((task) => task.taskId === panelTaskId);
  async function openTask(taskId: string, trigger: HTMLButtonElement) {
    if (viewBusy || loading) return;
    const request = ++panelRequest.current;
    if (!(await panelFlush.current()) || request !== panelRequest.current)
      return;
    panelTrigger.current = trigger;
    setPanelTaskId((current) => (current === taskId ? null : taskId));
    setPanelLocked(false);
  }
  function closeTask() {
    panelRequest.current++;
    setPanelTaskId(null);
    setPanelLocked(false);
    panelFlush.current = () => Promise.resolve(true);
    if (panelTrigger.current?.isConnected) panelTrigger.current.focus();
    else document.querySelector<HTMLInputElement>(".is-project-tasks [data-personal-capture]")?.focus();
  }
  const refresh = useCallback(
    async (id: string | null, reportFailure = false) => {
      const token = ++query.current;
      setLoading(true);
      try {
        const [next, rows, personal] = await Promise.all([
          projectStorage.listProjects(),
          id ? projectStorage.projectTasks(id) : Promise.resolve([]),
          personalTasks.read(),
        ]);
        if (token === query.current) {
          setWork(personal.work);
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
    const focus = () => window.dispatchEvent(new Event("praxis-lan-sync"));
    window.addEventListener("focus", focus);
    return () => {
      query.current++;
      window.removeEventListener("focus", focus);
    };
  }, [selectedId, refresh]);
  return (
    <ProjectTaskPanelContext.Provider
      value={{
        selectedTaskId: panelTaskId,
        disabled: locked || loading,
        open: openTask,
      }}
    >
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
              <button disabled={loading} onClick={() => void refresh(selectedId)}>
                重新读取项目
              </button>
            </p>
          )}
          <div className="project-body">
            {form && (
              <PersonalProjectForm
                key={form === "new" ? "new" : selectedId}
                initial={form === "edit" ? (selected ?? null) : null}
                createSave={() => desktopProjectSave(form === "edit" ? (selected ?? null) : null)}
                modal={form === "edit"}
                onBusyChange={setFormLocked}
                onCancel={() => setForm(null)}
                onSaved={async id => {
                  await refresh(id, true);
                  setSelectedId(id);
                  setForm(null);
                }}
              />
            )}
            {form !== "new" && selected && (
              <>
                {(selected.status === "archived" || !!selected.archivedAt) && (
                  <button className="project-back-button" onClick={onSettings}>
                    <ProjectIcon name="arrow" />
                    返回归档项目
                  </button>
                )}
                <button className="project-back-button" disabled={locked} onClick={() => setSelectedId(null)}>← 全部项目</button>
                <header className="project-summary">
                  <span className="project-summary-icon">
                    <ProjectIcon name="folder" />
                  </span>
                  <div className="project-summary-main">
                    <div className="project-heading">
                      <h2>{selected.name}</h2>
                      {selected.status && selected.status !== "active" && (
                        <span
                          className="state-badge"
                          data-state={selected.status ?? "active"}
                        >
                          {projectStates[selected.status ?? "active"]}
                        </span>
                      )}
                      <button
                        type="button"
                        className="project-settings-button"
                        aria-label="项目设置"
                        disabled={locked || loading}
                        onClick={() => setForm("edit")}
                      >
                        <ProjectIcon name="settings" />
                        设置
                      </button>
                    </div>
                    {selected.outcome && (
                      <p className="project-outcome">{selected.outcome}</p>
                    )}
                    {selected.targetDate && <small>目标日期 {selected.targetDate}</small>}
                  </div>
                  {work && <PersonalProjectProgress work={work} projectId={selected.id} />}
                  <div className="project-summary-aside">
                    {onOpenPersonalAgent && (
                      <div className="ai-planner-launch-group">
                        <button type="button" className="ai-planner-launch" disabled={locked || loading || (selected.status !== undefined && selected.status !== "active")} onClick={() => onOpenPersonalAgent("decompose",selected.id)}>✦ 拆成步骤</button>
                        <button type="button" className="ai-planner-launch" disabled={locked || loading} onClick={() => onOpenPersonalAgent("next",selected.id)}>✦ 下一步建议</button>
                      </div>
                    )}
                    <div className="project-view-controls">
                    <div
                      className="project-view-tabs"
                      role="tablist"
                      aria-label="项目视图"
                    >
                      {(
                        [
                          ["tasks", "列表"],
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
                            const keys = ["tasks", "board"] as const;
                            const index =
                              event.key === "Home"
                                ? 0
                                : event.key === "End"
                                  ? keys.length - 1
                                  : (keys.indexOf(key) +
                                      (event.key === "ArrowRight" ? 1 : keys.length - 1)) %
                                    keys.length;
                            const next = keys[index]!;
                            setMode(next);
                            document
                              .getElementById("project-view-" + next)
                              ?.focus();
                          }}
                        >
                          <ProjectIcon name={key} />
                        </button>
                      ))}
                    </div>
                    {mode === "board" && tasks.some((task) => task.status === "cancelled") && (
                      <TaskActionMenu label="任务筛选" disabled={locked}>
                        {(close) => (
                          <button
                            aria-pressed={showCancelled}
                            onClick={() => {
                              setShowCancelled(!showCancelled);
                              close();
                            }}
                          >
                            {showCancelled ? "隐藏已取消任务" : "显示已取消任务"}
                          </button>
                        )}
                      </TaskActionMenu>
                    )}
                    </div>
                  </div>
                </header>
                <div className="project-view-toolbar">
                  <span className="project-section-label">任务</span>
                </div>
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
                  {mode === "board" && (
                    <KanbanView
                      key={"board:" + selected.id}
                      tasks={tasks}
                      showCancelled={showCancelled}
                      disabled={loading || panelLocked}
                      onBusyChange={setViewBusy}
                      onSaved={() => refresh(selected.id, true)}
                    />
                  )}
                  {mode === "tasks" && (
                    <PersonalTodoHome key={selected.id} projectId={selected.id} embedded
                      revision={work?.tasks.map(t=>t.id+":"+t.version).join("|")}
                      externalBusy={loading || viewBusy || panelLocked || formLocked}
                      onBusyChange={setTaskBusy}
                      onOpenProject={setSelectedId}
                      onChanged={()=>void refresh(selected.id)} />
                  )}
                </div>
              </>
            )}
            {!form && !selected && work && (
              <PersonalProjectList work={work} disabled={locked || loading} onOpen={setSelectedId} onCreate={() => setForm("new")} onEdit={id => {if(!items.some(p=>p.id===id)){setError("项目资料已变化，请重新读取后编辑");return;}setSelectedId(id);setForm("edit");}} />
            )}
          </div>
        </div>
      </section>
      {!form && selected && panelTask && (
        <ProjectTaskPanel
          key={panelTask.taskId + ":" + panelRevision}
          task={panelTask}
          projectName={selected.name}
          projectId={selected.id}
          flush={panelFlush}
          onSaved={() => refresh(selected.id, true)}
          onClose={closeTask}
          onLockedChange={setPanelLocked}
          onReload={() => setPanelRevision((revision) => revision + 1)}
        />
      )}
    </ProjectTaskPanelContext.Provider>
  );
}
