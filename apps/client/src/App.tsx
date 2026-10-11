import { LanSyncStatus } from "./LanSyncStatus";
import { useLanRefresh } from "./useLanRefresh";
import { ProductivityView } from "./ProductivityView";
import { FollowedViews } from "./SearchViews";
import { DateStrip } from "./DateStrip";
import { ProjectNavigation } from "./ProjectNavigation";
import { SettingsView } from "./SettingsView";
import { ProjectIcon } from "./ProjectIcon";
import { projectStates, taskStates } from "@praxis/application";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { TaskActionMenu } from "./TaskActionMenu";
import { ProjectsView } from "./ProjectsView";
import { ContentView } from "./ContentView";
import { MobileCaptureView } from "./MobileCaptureView";
import { planning } from "./PlanningPanel";
import { PlanControls } from "./PlanControls";
import { App as NativeApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  calendarDate,
  CaptureToday,
  ChangeCompletion,
  type DailyTask,
  type EditReceipt,
  validCalendarDate,
  dayPeriods,
  dayPeriodLabels,
  orderedDayTasks,
  moveDayTaskChanges,
  taskPeriod,
  type DayPeriod,
  type PlanChange,
} from "@praxis/application";
import {
  nativeAvailable,
  taskStorage,
  desktopAvailable,
  completionStorage,
} from "./storage";

const todayTasks = new CaptureToday(taskStorage);
const completion = new ChangeCompletion(completionStorage);
function localDay() {
  const instant = new Date();
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return { instant, timeZone, date: calendarDate(instant, timeZone) };
}
function message(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === "string"
      ? error
      : "暂时无法完成操作，请重试。";
}

export function App() {
  const [workTaskId, setWorkTaskId] = useState<string | null>(null);
  const [workProjectId, setWorkProjectId] = useState<string | null>(null);
  const [workViewId, setWorkViewId] = useState<string | null>(null);
  const [workViewRevision, setWorkViewRevision] = useState(0);
  const [workReviewId, setWorkReviewId] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      setWorkReviewId((e as CustomEvent<string>).detail);
      setWorkViewId(null);
      setWorkTaskId(null);
      setWorkProjectId(null);
      setView("work");
    };
    window.addEventListener("praxis-work-review", open);
    return () => window.removeEventListener("praxis-work-review", open);
  }, []);
  useEffect(() => {
    const open = (e: Event) => {
      setWorkTaskId(null);
      setWorkViewId(null);
      setWorkReviewId(null);
      setWorkProjectId((e as CustomEvent<string>).detail);
      setView("work");
    };
    window.addEventListener("praxis-work-project", open);
    return () => window.removeEventListener("praxis-work-project", open);
  }, []);
  useEffect(() => {
    const open = (e: Event) => {
      setWorkViewId(null);
      setWorkProjectId(null);
      setWorkReviewId(null);
      setWorkTaskId((e as CustomEvent<string>).detail);
      setView("work");
    };
    window.addEventListener("praxis-work-task", open);
    return () => window.removeEventListener("praxis-work-task", open);
  }, []);
  const [projectNavigation, setProjectNavigation] = useState(0);
  const [projectBusy, setProjectBusy] = useState(false);
  const [detailBusy, setDetailBusy] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(false);
  const [captureFocusRevision, setCaptureFocusRevision] = useState(0);
  const [detailDirty, setDetailDirty] = useState(false);
  const [projectForm, setProjectForm] = useState<"new" | "edit" | null>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectRevision, setProjectRevision] = useState(0);
  const projectsChanged = useCallback(
    () => setProjectRevision((n) => n + 1),
    [],
  );
  const [view, setView] = useState<
    "day" | "inbox" | "projects" | "settings" | "work"
  >(desktopAvailable ? "work" : Capacitor.isNativePlatform() ? "inbox" : "day");
  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [view, projectId, projectNavigation]);
  const [planningBusy, setPlanningBusy] = useState(false);
  const [day, setDay] = useState(localDay);
  const [recoveryDate, setRecoveryDate] = useState<string | null>(null);
  const displayedDate = recoveryDate ?? day.date;
  const [editorRevision, setEditorRevision] = useState(0);
  const [editBaseline, setEditBaseline] = useState<DailyTask | null>(null);
  const [items, setItems] = useState<DailyTask[]>([]);
  const [title, setTitle] = useState("");
  const pendingDate = todayTasks.pendingDateFor(title, day.timeZone);
  const [changingId, setChangingId] = useState<string | null>(null);
  const [changeError, setChangeError] = useState("");
  const [showCompleted, setShowCompleted] = useState(false);
  const completedItems = items.filter((item) => item.status === "completed");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const queryVersion = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = items.find((item) => item.taskId === selectedId);
  const [pendingPlan, setPendingPlan] = useState<{
    date: string;
    changes: PlanChange[];
  } | null>(null);
  const draggingPlan = useRef<string | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    period: DayPeriod;
    planId?: string;
    position: "before" | "after";
  } | null>(null);
  const planLocked =
    planningBusy ||
    changingId !== null ||
    detailBusy ||
    detailDirty ||
    saving ||
    loading ||
    pendingPlan !== null;

  const refresh = useCallback(async (date: string) => {
    const version = ++queryVersion.current;
    setLoading(true);
    try {
      const tasks = await todayTasks.list(date);
      if (version === queryVersion.current) {
        setItems(tasks);
        setLoadError("");
        return tasks;
      }
    } catch (error) {
      if (version === queryVersion.current) setLoadError(message(error));
    } finally {
      if (version === queryVersion.current) setLoading(false);
    }
  }, []);
  useLanRefresh(
    () => todayTasks.list(displayedDate),
    setItems,
    planLocked || view !== "day",
    displayedDate,
  );
  const synced = useCallback(() => {
    window.dispatchEvent(new Event("praxis-lan-sync"));
    setProjectRevision((n) => n + 1);
  }, []);

  useEffect(() => {
    if (view === "day") void refresh(displayedDate);
    return () => {
      queryVersion.current += 1;
    };
  }, [displayedDate, refresh, view]);

  useEffect(() => {
    const update = () => {
      const current = localDay();
      setDay((previous) =>
        previous.date === current.date && previous.timeZone === current.timeZone
          ? previous
          : current,
      );
    };
    const onFocus = () => {
      update();
      void refresh(recoveryDate ?? localDay().date);
    };
    const timer = window.setInterval(update, 15_000);
    window.addEventListener("focus", onFocus);
    const listener = Capacitor.isNativePlatform()
      ? NativeApp.addListener("appStateChange", ({ isActive }) => {
          if (isActive) onFocus();
        })
      : undefined;
    return () => {
      void listener?.then((handle) => handle.remove());
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [refresh, recoveryDate]);

  function openInbox() {
    if (projectBusy || detailBusy || planningBusy || inboxBusy) return;
    setSelectedId(null);
    setView("inbox");
  }
  const quickCapture = useCallback(() => {
    if (
      projectBusy ||
      detailBusy ||
      planningBusy ||
      inboxBusy ||
      detailDirty ||
      (view === "day" && planLocked)
    )
      return;
    setSelectedId(null);
    setView("inbox");
    setCaptureFocusRevision((revision) => revision + 1);
  }, [
    projectBusy,
    detailBusy,
    planningBusy,
    inboxBusy,
    detailDirty,
    view,
    planLocked,
  ]);
  function openProject(id: string) {
    if (projectBusy || detailBusy || planningBusy || inboxBusy) return;
    setProjectForm(null);
    setProjectNavigation((n) => n + 1);
    setSelectedId(null);
    setProjectId(id);
    setView("projects");
  }
  function openSettings() {
    if (projectBusy || detailBusy || planningBusy || inboxBusy) return;
    setSelectedId(null);
    setView("settings");
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.repeat ||
        document.querySelector("dialog[open]") ||
        projectBusy ||
        detailBusy ||
        detailDirty ||
        (view === "day" && planLocked) ||
        planningBusy ||
        inboxBusy
      )
        return;
      if (
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "q" &&
        !(
          event.target instanceof Element &&
          event.target.closest("input, textarea, select, [contenteditable]")
        ) &&
        !document.querySelector(".task-action-popover,.date-picker-popover")
      ) {
        event.preventDefault();
        quickCapture();
      }
      if (
        desktopAvailable &&
        event.ctrlKey &&
        event.shiftKey &&
        event.key.toLowerCase() === "n"
      ) {
        event.preventDefault();
        setSelectedId(null);
        setView("inbox");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [
    projectBusy,
    detailBusy,
    detailDirty,
    planningBusy,
    inboxBusy,
    quickCapture,
    view,
    planLocked,
  ]);
  async function updatePlanning(changes: PlanChange[], date = displayedDate) {
    if (planningBusy) return;
    setPlanningBusy(true);
    setChangeError("");
    try {
      await planning.update(date, changes);
      setPendingPlan(null);
      const rows = await refresh(displayedDate);
      const current = rows?.find((task) => task.taskId === selectedId);
      if (current) {
        setEditBaseline(current);
        setEditorRevision((revision) => revision + 1);
      }
    } catch (error) {
      setChangeError(message(error));
      setPendingPlan({ date, changes });
    } finally {
      setPlanningBusy(false);
    }
  }
  async function savePlan(change: PlanChange) {
    if (planLocked) return;
    await updatePlanning([change]);
  }
  function moveDayTask(
    planId: string,
    period: DayPeriod,
    anchorId?: string,
    position: "before" | "after" = "before",
  ) {
    if (planLocked) return;
    const changes = moveDayTaskChanges(
      items,
      planId,
      period,
      anchorId,
      position,
    );
    if (changes.length) void updatePlanning(changes);
  }
  function clearDrag() {
    draggingPlan.current = null;
    setDraggingId(null);
    setDropTarget(null);
  }
  function dropTask(
    event: DragEvent,
    period: DayPeriod,
    anchorId?: string,
    position: "before" | "after" = "before",
  ) {
    if (!draggingPlan.current) return;
    event.preventDefault();
    event.stopPropagation();
    const planId = draggingPlan.current;
    clearDrag();
    moveDayTask(planId, period, anchorId, position);
  }
  function moveWithKeyboard(event: ReactKeyboardEvent, task: DailyTask) {
    if (planLocked) return;
    const period = taskPeriod(task);
    const tasks = orderedDayTasks(items, period);
    const index = tasks.findIndex((item) => item.planId === task.planId);
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const target = tasks[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target)
        moveDayTask(
          task.planId,
          period,
          target.planId,
          event.key === "ArrowUp" ? "before" : "after",
        );
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const target =
        dayPeriods[
          dayPeriods.indexOf(period) + (event.key === "ArrowLeft" ? -1 : 1)
        ];
      if (target) moveDayTask(task.planId, target);
    }
  }
  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || planningBusy) return;
    setSaving(true);
    setSaveError("");
    try {
      const current = localDay();
      setDay(current);
      const task = await todayTasks.add(title, current.timeZone);
      setTitle("");
      // A refresh failure must not imply that the successful save failed.
      setRecoveryDate(
        task.executionDate !== current.date ? task.executionDate : null,
      );
      await refresh(task.executionDate);
      inputRef.current?.focus();
    } catch (error) {
      setSaveError(message(error));
    } finally {
      setSaving(false);
    }
  }

  async function changeStatus(item: DailyTask) {
    if (changingId || planningBusy || pendingPlan) return;
    setChangingId(item.taskId);
    setChangeError("");
    try {
      const updated = await completion.change(
        item,
        item.status === "completed" ? "undo" : "complete",
        localDay().timeZone,
      );
      const resultDate =
        updated.status === "completed"
          ? (updated.completionDate ?? localDay().date)
          : updated.executionDate;
      setRecoveryDate(resultDate !== localDay().date ? resultDate : null);
      await refresh(resultDate);
    } catch (error) {
      setChangeError(message(error));
    } finally {
      setChangingId(null);
    }
  }

  async function showEdited(receipt: EditReceipt) {
    const date =
      receipt.after.status === "completed"
        ? (receipt.after.completionDate ?? displayedDate)
        : receipt.after.executionDate;
    setRecoveryDate(date === localDay().date ? null : date);
    setEditBaseline(receipt.after);
    setEditorRevision((value) => value + 1);
    await refresh(date);
  }
  function selectDate(date: string) {
    if (projectBusy || detailBusy || planningBusy || inboxBusy || detailDirty)
      return;
    if (!validCalendarDate(date)) return;
    setSelectedId(null);
    setView("day");
    setRecoveryDate(date === localDay().date ? null : date);
  }

  function taskRow(item: DailyTask) {
    const canArrange =
      desktopAvailable &&
      ["todo", "in_progress", "blocked"].includes(item.status);
    const targeted = dropTarget?.planId === item.planId;
    return (
      <li
        key={item.planId}
        data-plan-id={item.planId}
        className={`task-item${item.status === "completed" ? " completed" : ""}${draggingId === item.planId ? " is-dragging" : ""}${targeted ? " drop-" + dropTarget.position : ""}`}
        draggable={canArrange && !planLocked}
        onDragStart={(event) => {
          if (!canArrange || planLocked) {
            event.preventDefault();
            return;
          }
          draggingPlan.current = item.planId;
          setDraggingId(item.planId);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("application/x-praxis-plan", item.planId);
        }}
        onDragEnd={clearDrag}
        onDragOver={(event) => {
          if (!canArrange || !draggingPlan.current || planLocked) return;
          event.preventDefault();
          event.stopPropagation();
          event.dataTransfer.dropEffect = "move";
          const rect = event.currentTarget.getBoundingClientRect();
          setDropTarget({
            period: taskPeriod(item),
            planId: item.planId,
            position:
              event.clientY < rect.top + rect.height / 2 ? "before" : "after",
          });
        }}
        onDrop={(event) => {
          if (!canArrange) return;
          const rect = event.currentTarget.getBoundingClientRect();
          dropTask(
            event,
            taskPeriod(item),
            item.planId,
            event.clientY < rect.top + rect.height / 2 ? "before" : "after",
          );
        }}
      >
        {canArrange && (
          <button
            className="task-drag-handle"
            disabled={planLocked}
            aria-label={`拖动排序：${item.title}`}
            aria-describedby="task-sort-help"
            title="拖动排序；方向键调整顺序与时段"
            onKeyDown={(event) => moveWithKeyboard(event, item)}
          >
            <svg viewBox="0 0 16 20" aria-hidden="true">
              <path d="M5 4h.01M11 4h.01M5 10h.01M11 10h.01M5 16h.01M11 16h.01" />
            </svg>
          </button>
        )}
        {desktopAvailable && (
          <button
            className="completion-toggle"
            aria-pressed={item.status === "completed"}
            aria-busy={changingId === item.taskId}
            aria-label={item.status === "completed" ? "撤销完成" : "标为完成"}
            title={item.title}
            disabled={
              changingId !== null ||
              planningBusy ||
              detailBusy ||
              detailDirty ||
              pendingPlan !== null
            }
            onClick={() => {
              void changeStatus(item);
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {changingId === item.taskId ? (
                <path className="completion-spinner" d="M12 3a9 9 0 1 1-9 9" />
              ) : (
                <>
                  <circle cx="12" cy="12" r="9" />
                  {item.status === "completed" && (
                    <path className="completion-check" d="m7.5 12 3 3 6-6" />
                  )}
                </>
              )}
            </svg>
          </button>
        )}
        <button
          disabled={detailBusy || planningBusy}
          className={
            selectedId === item.taskId ? "task-row selected" : "task-row"
          }
          onClick={() => {
            setEditBaseline(item);
            setSelectedId(selectedId === item.taskId ? null : item.taskId);
          }}
          aria-expanded={selectedId === item.taskId}
        >
          {!desktopAvailable && (
            <span className="task-circle" aria-hidden="true" />
          )}
          <span className="task-text">
            <span className="task-title">
              {item.important && (
                <span className="task-important" aria-label="重要任务">
                  重要
                </span>
              )}
              {item.title}
            </span>
            <span className="task-meta">
              {item.status !== "todo" && item.status !== "completed" && (
                <>
                  {taskStates[item.status]}
                  {item.statusReason ? "：" + item.statusReason : ""} ·{" "}
                </>
              )}
              {item.projectStatus && item.projectStatus !== "active" && (
                <>项目{projectStates[item.projectStatus]} · </>
              )}
              {item.executionDate !== displayedDate && (
                <>安排于 {item.executionDate}</>
              )}
            </span>
          </span>
          <span className="task-arrow" aria-hidden="true">
            ↗
          </span>
        </button>
        {desktopAvailable && item.status !== "completed" && (
          <PlanControls
            key={item.planId + ":" + item.version}
            task={item}
            busy={planLocked}
            onChange={savePlan}
          />
        )}
        {desktopAvailable && (
          <TaskActionMenu
            key={item.planId + ":actions:" + item.version}
            label={`更多操作：${item.title}`}
            disabled={planLocked}
          >
            {(close) => (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setEditBaseline(item);
                    setSelectedId(item.taskId);
                    close();
                  }}
                >
                  打开任务详情
                </button>
                {canArrange && (
                  <>
                    <p className="task-action-label">移动到时段</p>
                    {dayPeriods.map((period) => (
                      <button
                        type="button"
                        key={period}
                        disabled={taskPeriod(item) === period}
                        onClick={() => {
                          moveDayTask(item.planId, period);
                          close();
                        }}
                      >
                        {dayPeriodLabels[period]}
                        {taskPeriod(item) === period ? " · 当前" : ""}
                      </button>
                    ))}
                  </>
                )}
              </>
            )}
          </TaskActionMenu>
        )}
      </li>
    );
  }

  return (
    <main
      className="workspace reference-workspace todoist-workspace"
      ref={workspaceRef}
    >
      <aside className="sidebar">
        <a className="brand" href="#today" aria-label="Praxis 首页">
          <span className="brand-mark">P</span>Praxis
          <span className="brand-dot">.</span>
        </a>

        <nav aria-label="主导航">
          {desktopAvailable && (
            <button
              className="nav-item quick-capture"
              aria-keyshortcuts="Q"
              title="随手记（Q）"
              disabled={
                projectBusy ||
                detailBusy ||
                planningBusy ||
                inboxBusy ||
                detailDirty ||
                (view === "day" && planLocked)
              }
              onClick={quickCapture}
            >
              <span className="quick-capture-icon" aria-hidden="true">
                +
              </span>
              随手记
              <span className="nav-shortcut" aria-hidden="true">
                Q
              </span>
            </button>
          )}
          {desktopAvailable && (
            <button
              className={view === "work" ? "nav-item active" : "nav-item"}
              disabled={projectBusy || detailBusy || planningBusy || inboxBusy}
              onClick={() => {
                setWorkTaskId(null);
                setWorkProjectId(null);
                setWorkViewId(null);
                setWorkReviewId(null);
                setView("work");
              }}
            >
              今日与近期
            </button>
          )}
          <a
            className={view === "day" ? "nav-item active" : "nav-item"}
            href="#today"
            aria-current={view === "day" ? "page" : undefined}
            aria-disabled={
              projectBusy || detailBusy || planningBusy || inboxBusy
            }
            onClick={(event) => {
              if (projectBusy || detailBusy || planningBusy || inboxBusy)
                event.preventDefault();
              else selectDate(localDay().date);
            }}
          >
            <TaskPanelIcon name="sun" />
            每日安排
            <span className="nav-shortcut">
              {
                items.filter(
                  (task) => !["completed", "cancelled"].includes(task.status),
                ).length
              }
            </span>
          </a>
          {desktopAvailable && (
            <button
              className={view === "inbox" ? "nav-item active" : "nav-item"}
              disabled={projectBusy || detailBusy || planningBusy || inboxBusy}
              onClick={openInbox}
            >
              <TaskPanelIcon name="inbox" />
              收件箱 <span className="nav-shortcut">Ctrl ⇧ N</span>
            </button>
          )}
        </nav>
        {!desktopAvailable && Capacitor.isNativePlatform() && (
          <button
            className={view === "inbox" ? "nav-item active" : "nav-item"}
            onClick={() => setView("inbox")}
          >
            本机收件箱
          </button>
        )}
        {desktopAvailable && (
          <FollowedViews
            revision={projectRevision}
            disabled={projectBusy || detailBusy || planningBusy || inboxBusy}
            onOpen={(id) => {
              setWorkViewId(id);
              setWorkReviewId(null);
              setWorkViewRevision((n) => n + 1);
              setWorkTaskId(null);
              setWorkProjectId(null);
              setView("work");
            }}
          />
        )}
        {desktopAvailable && (
          <ProjectNavigation
            revision={projectRevision}
            disabled={projectBusy || detailBusy || planningBusy || inboxBusy}
            selectedId={
              view === "projects" && projectForm !== "new" ? projectId : null
            }
            onSelect={openProject}
            onCreate={() => {
              if (projectBusy || detailBusy || planningBusy || inboxBusy)
                return;
              setProjectForm("new");
              setProjectNavigation((n) => n + 1);
              setSelectedId(null);
              setView("projects");
            }}
          />
        )}
        {desktopAvailable && (
          <button
            className={
              view === "settings"
                ? "sidebar-settings active"
                : "sidebar-settings"
            }
            aria-current={view === "settings" ? "page" : undefined}
            disabled={projectBusy || detailBusy || planningBusy || inboxBusy}
            onClick={openSettings}
          >
            <ProjectIcon name="settings" />
            设置
          </button>
        )}
        <div className="sidebar-foot">
          <span className="status-dot" />
          本地工作空间
        </div>
        {desktopAvailable && <LanSyncStatus onRefresh={synced} />}
      </aside>
      {view === "work" ? (
        <ProductivityView
          initialTaskId={workTaskId}
          initialProjectId={workProjectId}
          initialViewId={workViewId}
          initialReviewId={workReviewId}
          viewRevision={workViewRevision}
          onChanged={projectsChanged}
          onBusyChange={setInboxBusy}
        />
      ) : view === "projects" ? (
        <ProjectsView
          form={projectForm}
          onFormChange={setProjectForm}
          navigationRevision={projectNavigation}
          onBusyChange={setProjectBusy}
          selectedId={projectId}
          onSelect={setProjectId}
          onProjectsChanged={projectsChanged}
          onSettings={openSettings}
          onDay={(date) => {
            selectDate(date);
            void refresh(date);
          }}
        />
      ) : view === "settings" ? (
        <SettingsView revision={projectRevision} onOpenProject={openProject} />
      ) : view === "inbox" && !desktopAvailable ? (
        <MobileCaptureView onBusyChange={setInboxBusy} />
      ) : view === "inbox" ? (
        <ContentView
          onChanged={projectsChanged}
          focusRevision={captureFocusRevision}
          onBusyChange={setInboxBusy}
          onScheduled={(date) => {
            setSelectedId(null);
            setView("day");
            setRecoveryDate(date === localDay().date ? null : date);
            void refresh(date);
          }}
        />
      ) : (
        <section
          className="today reference-day"
          id="today"
          aria-labelledby="today-title"
        >
          <div className="today-content">
            <header className="day-toolbar">
              <h1 id="today-title" className="sr-only">
                {recoveryDate ? "日程" : "今日"}
              </h1>
              <DateStrip
                date={displayedDate}
                today={day.date}
                onSelect={selectDate}
                disabled={planningBusy || detailBusy || detailDirty}
              />
            </header>
            <form
              className="capture-form"
              onSubmit={(event) => {
                void capture(event);
              }}
              aria-label="添加今日任务"
            >
              <span className="capture-circle" aria-hidden="true" />
              <label className="sr-only" htmlFor="task-title">
                任务标题
              </label>
              <input
                ref={inputRef}
                id="task-title"
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setSaveError("");
                }}
                placeholder="添加今日任务，按回车保存"
                autoComplete="off"
                disabled={saving || planningBusy || !nativeAvailable}
                aria-invalid={Boolean(saveError)}
                aria-describedby={saveError ? "save-error" : undefined}
              />
              {(saving || pendingDate) && (
                <span className="capture-status" role="status">
                  {saving ? "保存中…" : "按回车重试"}
                </span>
              )}
            </form>
            {saveError && (
              <p className="error" id="save-error" role="alert">
                {saveError}
              </p>
            )}
            <p id="task-sort-help" className="sr-only">
              拖动任务可调整顺序和时段；聚焦拖动按钮后，上下方向键排序，左右方向键切换时段。
            </p>
            {loadError ? (
              <div className="load-error" role="alert">
                <p>{loadError}</p>
                {nativeAvailable && (
                  <button
                    onClick={() => {
                      void refresh(displayedDate);
                    }}
                  >
                    重新读取
                  </button>
                )}
              </div>
            ) : loading ? (
              <p className="loading" role="status">
                正在读取本机任务…
              </p>
            ) : (
              <div className="day-periods" aria-busy={planningBusy}>
                {dayPeriods.map((period) => {
                  const tasks = orderedDayTasks(items, period);
                  return (
                    <section
                      key={period}
                      className={`day-period${dropTarget?.period === period && !dropTarget.planId ? " is-drop-target" : ""}`}
                      aria-label={dayPeriodLabels[period]}
                      data-period={period}
                      onDragOver={(event) => {
                        if (!draggingPlan.current || planLocked) return;
                        event.preventDefault();
                        event.dataTransfer.dropEffect = "move";
                        setDropTarget({ period, position: "after" });
                      }}
                      onDragLeave={(event) => {
                        if (
                          !event.currentTarget.contains(
                            event.relatedTarget as Node | null,
                          )
                        )
                          setDropTarget(null);
                      }}
                      onDrop={(event) => dropTask(event, period)}
                    >
                      <div className="list-heading">
                        <h2>
                          {dayPeriodLabels[period]} <span>{tasks.length}</span>
                        </h2>
                      </div>
                      <ul className="task-list">{tasks.map(taskRow)}</ul>
                      {tasks.length === 0 && (
                        <p className="period-empty">
                          {draggingId ? "拖到这里安排" : "暂无安排"}
                        </p>
                      )}
                    </section>
                  );
                })}
              </div>
            )}

            {changeError && (
              <div className="error" role="alert">
                {changeError}
                {pendingPlan && (
                  <button
                    disabled={planningBusy}
                    onClick={() => {
                      void updatePlanning(
                        pendingPlan.changes,
                        pendingPlan.date,
                      );
                    }}
                  >
                    重试保存排序与星标
                  </button>
                )}
                <button
                  disabled={planningBusy}
                  onClick={() => {
                    void refresh(displayedDate);
                    setChangeError("");
                    setPendingPlan(null);
                  }}
                >
                  重新读取
                </button>
              </div>
            )}
            {!loading && !loadError && completedItems.length > 0 && (
              <section className="completed-section" aria-label="已完成任务">
                <button
                  className="completed-heading"
                  aria-expanded={showCompleted}
                  onClick={() => setShowCompleted(!showCompleted)}
                >
                  {showCompleted ? "⌄" : "›"} 已完成 · {completedItems.length}
                </button>
                {showCompleted && (
                  <ul className="task-list">{completedItems.map(taskRow)}</ul>
                )}
              </section>
            )}
          </div>
        </section>
      )}
      {selected && view === "day" && desktopAvailable && (
        <TaskDetailPanel
          key={selected.taskId + ":" + editorRevision}
          task={
            editBaseline?.taskId === selected.taskId ? editBaseline : selected
          }
          onSaved={showEdited}
          onUpdated={async () => {
            const rows = await refresh(displayedDate);
            const current = rows?.find(
              (task) => task.taskId === selected.taskId,
            );
            if (current) {
              setEditBaseline(current);
              setEditorRevision((revision) => revision + 1);
            }
          }}
          onClose={() => setSelectedId(null)}
          onComplete={async () => {
            await changeStatus(selected);
            setEditBaseline(null);
            setEditorRevision((revision) => revision + 1);
          }}
          onProject={openProject}
          onBusyChange={setDetailBusy}
          onDirtyChange={setDetailDirty}
        />
      )}
    </main>
  );
}
