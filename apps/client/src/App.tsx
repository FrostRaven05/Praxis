import "./personal-shell.css";
import { AccountButton, AccountPage, type SettingsSection } from "./AccountPanel";
import { PersonalAgentPanel } from "./PersonalAgentPanel";
import { PersonalTodoHome } from "./PersonalTodoHome";
import { LanSyncStatus } from "./LanSyncStatus";
import { useLanRefresh } from "./useLanRefresh";
import { ProductivityView, type TodayContent } from "./ProductivityView";
import { dayTimeline, recommendBacklog } from "./day-timeline";
import { DailyHabitTask, useDailyHabitTasks } from "./DailyHabitTasks";
import { HabitDetailPanel } from "./HabitDetailPanel";
import type { Row as HabitRow } from "./HabitsView";
import { DateStrip } from "./DateStrip";
import { ProjectNavigation } from "./ProjectNavigation";
import { ProjectIcon } from "./ProjectIcon";
import { projectStates, taskStates } from "@praxis/application";
import { TaskDetailPanel } from "./TaskDetailPanel";
import { TaskPanelIcon } from "./TaskPanelIcon";
import { TaskCompletionButton } from "./TaskCompletionButton";
import { TaskCompletionTitle } from "./TaskCompletionTitle";
import { animateTaskCompletion } from "./task-completion-motion";
import { ActionNotice } from "./ActionNotice";
import { PomodoroDock } from "./PomodoroDock";
import { personalTasks } from "./personal-task-storage";
import { noteCardText } from "./task-note";
import { ProjectsView } from "./ProjectsView";
import { InboxView } from "./InboxView";
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
  orderedDayItems,
  moveDayItems,
  planChange,
  type DayArrangementItem,
  type HabitPlanChange,
  taskPeriod,
  type DayPeriod,
  type PlanChange,
  type WorkTask,
  type TimeValue,
} from "@praxis/application";
import {
  nativeAvailable,
  taskStorage,
  desktopAvailable,
  completionStorage,
} from "./storage";

const todayTasks = new CaptureToday(taskStorage);
async function listedDay(date: string) {
  const [tasks, personal] = await Promise.all([
    todayTasks.list(date),
    personalTasks.read().catch(() => null),
  ]);
  const notes = new Map(
    personal?.work.tasks.map((task) => [task.id, task.notes]) ?? [],
  );
  return tasks.map((task) => ({
    ...task,
    notes: notes.get(task.taskId) ?? "",
  }));
}
const completion = new ChangeCompletion(completionStorage);
const periodTitles: Record<(typeof dayPeriods)[number], string> = {
  morning: "早上",
  afternoon: "中午",
  evening: "晚上",
};
function localDay(timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  const instant = new Date();
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
  const [personalAgent, setPersonalAgent] = useState<{mode:"decompose"|"next";projectId?:string}|null>(null);
  useEffect(()=>{if(personalAgent)setInboxBusy(true);return()=>{if(personalAgent)setInboxBusy(false);};},[personalAgent]);
  const [workTaskId, setWorkTaskId] = useState<string | null>(null);
  const [workProjectId, setWorkProjectId] = useState<string | null>(null);
  const [workSearchRevision, setWorkSearchRevision] = useState(0);
  const [workStartTab, setWorkStartTab] = useState<"today" | "search" | "trash">("today");
  const [timelineTab, setTimelineTab] = useState("today");
  const [workReviewId, setWorkReviewId] = useState<string | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      setWorkReviewId((e as CustomEvent<string>).detail);
      setWorkTaskId(null);
      setWorkProjectId(null);
      setView("day");
    };
    window.addEventListener("praxis-work-review", open);
    return () => window.removeEventListener("praxis-work-review", open);
  }, []);
  useEffect(() => {
    const open = (e: Event) => {
      setWorkProjectId(null);
      setWorkReviewId(null);
      setWorkTaskId((e as CustomEvent<string>).detail);
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
  const [view, setView] = useState<"todos" | "day" | "inbox" | "projects">(
    "todos",
  );
  const [accountOpen, setAccountOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("account");
  useEffect(() => {
    workspaceRef.current?.scrollTo({ top: 0 });
  }, [view, projectId, projectNavigation]);
  const [planningBusy, setPlanningBusy] = useState(false);
  const [acceptingSuggestion, setAcceptingSuggestion] = useState<string | null>(
    null,
  );
  const suggestionSaving = useRef(false);
  const [day, setDay] = useState(localDay);
  const [workspaceZone, setWorkspaceZone] = useState<string | null>(null);
  const applyWorkspaceZone = useCallback((zone: string) => {
    setWorkspaceZone(zone);
    setDay((previous) => {
      const current = localDay(zone);
      return previous.date === current.date && previous.timeZone === zone
        ? previous
        : current;
    });
  }, []);
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
  const [notice, setNotice] = useState<{
    message: string;
    destination?: string;
  }>({ message: "" });
  const [completionUndo, setCompletionUndo] = useState<DailyTask | null>(null);
  useEffect(() => {
    setNotice({ message: "" });
    setCompletionUndo(null);
  }, [view]);
  const completedItems = items.filter((item) => item.status === "completed");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [saveError, setSaveError] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedHabitId, setSelectedHabitId] = useState<string | null>(null);
  useEffect(() => {
    setSelectedHabitId(null);
  }, [view, displayedDate, timelineTab]);
  useEffect(() => {
    if (inboxBusy) setSelectedHabitId(null);
  }, [inboxBusy]);
  const handleTimelineTab = useCallback((tab: string) => {
    setTimelineTab(tab);
    if (tab !== "today") setSelectedId(null);
  }, []);
  const queryVersion = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selected = items.find((item) => item.taskId === selectedId);
  const [pendingPlan, setPendingPlan] = useState<{
    date: string;
    changes: PlanChange[];
    habitChanges?: HabitPlanChange[];
  } | null>(null);
  const draggingPlan = useRef<string | null>(null);
  const dailyHabits = useDailyHabitTasks(
    displayedDate,
    desktopAvailable && view === "day",
    planningBusy || detailBusy || detailDirty || inboxBusy,
  );
  const completedHabits = dailyHabits.rows.filter(
    (row) => row.entry?.status === "done",
  );
  const selectedHabit = dailyHabits.rows.find(
    (row) => row.habit.id === selectedHabitId,
  );
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{
    period: DayPeriod;
    planId?: string;
    position: "before" | "after";
  } | null>(null);
  const planLocked =
    dailyHabits.busy ||
    planningBusy ||
    changingId !== null ||
    detailBusy ||
    detailDirty ||
    saving ||
    inboxBusy ||
    loading ||
    pendingPlan !== null;

  const refresh = useCallback(async (date: string) => {
    const version = ++queryVersion.current;
    setLoading(true);
    try {
      const tasks = await listedDay(date);
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
    () => listedDay(displayedDate),
    setItems,
    planLocked || view !== "day",
    displayedDate,
  );
  const synced = useCallback(() => {
    window.dispatchEvent(new Event("praxis-lan-sync"));
    setProjectRevision((n) => n + 1);
  }, []);
  const workChanged = useCallback(() => {
    projectsChanged();
    void refresh(displayedDate);
  }, [projectsChanged, refresh, displayedDate]);

  useEffect(() => {
    if (view === "day") void refresh(displayedDate);
    return () => {
      queryVersion.current += 1;
    };
  }, [displayedDate, refresh, view]);

  useEffect(() => {
    const update = () => {
      const current = localDay(workspaceZone ?? undefined);
      setDay((previous) =>
        previous.date === current.date && previous.timeZone === current.timeZone
          ? previous
          : current,
      );
    };
    const onFocus = () => {
      update();
      void refresh(recoveryDate ?? localDay(workspaceZone ?? undefined).date);
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
  }, [refresh, recoveryDate, workspaceZone]);

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
    setWorkTaskId(null);
    setView("todos");
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
  const openProject = useCallback(
    (id: string | null) => {
      if (
        projectBusy ||
        detailBusy ||
        planningBusy ||
        inboxBusy ||
        detailDirty ||
        (view === "day" && planLocked)
      )
        return;
      setProjectForm(null);
      setProjectNavigation((n) => n + 1);
      setSelectedId(null);
      setWorkTaskId(null);
      setWorkReviewId(null);
      setWorkProjectId(null);
      setProjectId(id);
      setView("projects");
    },
    [
      projectBusy,
      detailBusy,
      planningBusy,
      inboxBusy,
      detailDirty,
      view,
      planLocked,
    ],
  );
  useEffect(() => {
    const open = (e: Event) => openProject((e as CustomEvent<string>).detail);
    window.addEventListener("praxis-work-project", open);
    return () => window.removeEventListener("praxis-work-project", open);
  }, [openProject]);
  useEffect(() => {
    const manage = (event: Event) => {
      if (projectBusy || detailBusy || planningBusy || inboxBusy || detailDirty || (view === "day" && planLocked)) return;
      setProjectForm(null);
      setWorkTaskId(null);
      setWorkReviewId(null);
      setWorkProjectId((event as CustomEvent<string>).detail);
      setView("day");
    };
    window.addEventListener("praxis-project-settings", manage);
    return () => window.removeEventListener("praxis-project-settings", manage);
  }, [projectBusy, detailBusy, planningBusy, inboxBusy, detailDirty, view, planLocked]);
  function openSettings() {
    if (projectBusy || detailBusy || planningBusy || inboxBusy) return;
    setSettingsSection("account");
    setAccountOpen(true);
  }
  function openTodos() {
    if(projectBusy || detailBusy || planningBusy || inboxBusy || detailDirty || (view==="day" && planLocked)) return;
    setSelectedId(null);setWorkTaskId(null);setWorkProjectId(null);setWorkReviewId(null);setView("todos");
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
        quickCapture();
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
  async function updatePlanning(
    changes: PlanChange[],
    date = displayedDate,
    habitChanges: HabitPlanChange[] = [],
  ) {
    if (planningBusy) return;
    setPlanningBusy(true);
    setChangeError("");
    try {
      await planning.update(date, changes, habitChanges);
      setPendingPlan(null);
      await dailyHabits.refresh();
      const rows = await refresh(displayedDate);
      const current = rows?.find((task) => task.taskId === selectedId);
      if (current) {
        setEditBaseline(current);
        setEditorRevision((revision) => revision + 1);
      }
    } catch (error) {
      const text = message(error);
      setChangeError(
        text.includes("STATE_CONFLICT")
          ? "任务或习惯安排已更新，请重新读取后再调整。"
          : text,
      );
      setPendingPlan({ date, changes, habitChanges });
    } finally {
      setPlanningBusy(false);
    }
  }
  async function savePlan(change: PlanChange) {
    if (planLocked) return;
    await updatePlanning([change]);
  }
  function dailyArrangementRows(): (DayArrangementItem & {
    task?: DailyTask;
    habit?: HabitRow;
  })[] {
    return [
      ...items
        .filter((task) =>
          ["todo", "in_progress", "blocked"].includes(task.status),
        )
        .map((task) => ({
          key: task.planId,
          dayPeriod: taskPeriod(task),
          dayRank: task.dayRank ?? 0,
          createdAt: task.createdAt,
          task,
        })),
      ...dailyHabits.rows
        .filter((habit) => habit.entry?.status !== "done")
        .map((habit) => ({
          key: `habit:${habit.habit.id}`,
          dayPeriod: habit.placement.dayPeriod,
          dayRank: habit.placement.dayRank,
          createdAt: habit.habit.createdAt,
          habit,
        })),
    ];
  }
  function moveDayTask(
    planId: string,
    period: DayPeriod,
    anchorId?: string,
    position: "before" | "after" = "before",
  ) {
    if (planLocked) return;
    const rows = dailyArrangementRows();
    const movement = moveDayItems(rows, planId, period, anchorId, position);
    const changes: PlanChange[] = [],
      habitChanges: HabitPlanChange[] = [];
    for (const move of movement) {
      const row = rows.find((row) => row.key === move.key)!;
      if (row.task)
        changes.push({
          ...planChange(row.task),
          dayPeriod: move.dayPeriod,
          dayRank: move.dayRank,
        });
      if (row.habit)
        habitChanges.push({
          habitId: row.habit.habit.id,
          expectedVersion: row.habit.placement.version,
          dayPeriod: move.dayPeriod,
          dayRank: move.dayRank,
        });
    }
    if (movement.length)
      void updatePlanning(changes, displayedDate, habitChanges);
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
  function moveWithKeyboard(event: ReactKeyboardEvent, key: string) {
    if (planLocked) return;
    const rows = dailyArrangementRows();
    const task = rows.find((row) => row.key === key);
    if (!task) return;
    const period = task.dayPeriod;
    const tasks = orderedDayItems(rows, period);
    const index = tasks.findIndex((item) => item.key === key);
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const target = tasks[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (target)
        moveDayTask(
          key,
          period,
          target.key,
          event.key === "ArrowUp" ? "before" : "after",
        );
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const target =
        dayPeriods[
          dayPeriods.indexOf(period) + (event.key === "ArrowLeft" ? -1 : 1)
        ];
      if (target) moveDayTask(key, target);
    }
  }
  async function capture(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (saving || planningBusy) return;
    setSaving(true);
    setSaveError("");
    try {
      const current = localDay(day.timeZone);
      setDay(current);
      const task = await todayTasks.add(title, current.timeZone, displayedDate);
      setTitle("");
      setCompletionUndo(null);
      // A refresh failure must not imply that the successful save failed.
      setRecoveryDate(
        task.executionDate !== current.date ? task.executionDate : null,
      );
      await refresh(task.executionDate);
      inputRef.current?.focus();
    } catch (error) {
      const pending = todayTasks.pendingDateFor(title, day.timeZone);
      if (pending) setRecoveryDate(pending);
      setSaveError(message(error));
    } finally {
      setSaving(false);
    }
  }

  async function acceptSuggestion(task: WorkTask, zone: string) {
    if (planLocked || suggestionSaving.current) return;
    suggestionSaving.current = true;
    setPlanningBusy(true);
    setAcceptingSuggestion(task.id);
    setChangeError("");
    try {
      await planning.acceptSuggestion(
        {
          taskId: task.id,
          title: task.title,
          version: task.version,
          createdAt: task.createdAt,
        },
        displayedDate,
        zone,
      );
      await refresh(displayedDate);
      workChanged();
    } catch (error) {
      setChangeError(message(error));
    } finally {
      suggestionSaving.current = false;
      setAcceptingSuggestion(null);
      setPlanningBusy(false);
    }
  }

  async function changeStatus(item: DailyTask) {
    if (changingId || planningBusy || pendingPlan) return;
    setChangingId(item.taskId);
    setChangeError("");
    let clearMotion = () => {};
    try {
      const updated = await completion.change(
        item,
        item.status === "completed" ? "undo" : "complete",
        day.timeZone,
      );
      if (updated.status === "completed") clearMotion = await animateTaskCompletion(item.taskId);
      setCompletionUndo(updated.status === "completed" ? updated : null);
      setNotice({
        message:
          updated.status === "completed"
            ? `已完成「${updated.title}」`
            : `已撤销完成「${updated.title}」`,
      });
      setSelectedId(null);
      await refresh(displayedDate);
    } catch (error) {
      setChangeError(message(error));
    } finally {
      clearMotion();
      setChangingId(null);
    }
  }

  async function showEdited(receipt: EditReceipt) {
    const date =
      receipt.after.status === "completed"
        ? (receipt.after.completionDate ?? displayedDate)
        : receipt.after.executionDate;
    setRecoveryDate(date === localDay(day.timeZone).date ? null : date);
    setEditBaseline(receipt.after);
    await refresh(date);
  }
  function selectDate(date: string) {
    if (projectBusy || detailBusy || planningBusy || inboxBusy || detailDirty)
      return;
    if (!validCalendarDate(date)) return;
    setSelectedId(null);
    setWorkTaskId(null);
    setWorkProjectId(null);
    setWorkReviewId(null);
    setWorkStartTab("today");
    setWorkSearchRevision((n) => n + 1);
    setView("day");
    setRecoveryDate(date === localDay(day.timeZone).date ? null : date);
  }

  function taskCreated(title: string, plan: TimeValue | null) {
    setCompletionUndo(null);
    const date =
      plan?.kind === "date"
        ? plan.date
        : plan?.kind === "instant"
          ? calendarDate(new Date(plan.atUtc), day.timeZone)
          : null;
    setNotice({
      message: date
        ? `「${title}」已添加到 ${date}`
        : `「${title}」已保存到收件箱`,
      destination: date ?? "inbox",
    });
  }

  function rowDragProps(key: string, canArrange = true) {
    return {
      draggable: canArrange && !planLocked,
      onDragStart: (event: DragEvent<HTMLLIElement>) => {
        if (!canArrange || planLocked) {
          event.preventDefault();
          return;
        }
        draggingPlan.current = key;
        setDraggingId(key);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("application/x-praxis-plan", key);
      },
      onDragEnd: clearDrag,
      onDragOver: (event: DragEvent<HTMLLIElement>) => {
        if (!canArrange || !draggingPlan.current || planLocked) return;
        event.preventDefault();
        event.stopPropagation();
        event.dataTransfer.dropEffect = "move";
        const row = dailyArrangementRows().find((row) => row.key === key);
        if (!row) return;
        const rect = event.currentTarget.getBoundingClientRect();
        setDropTarget({
          period: row.dayPeriod,
          planId: key,
          position:
            event.clientY < rect.top + rect.height / 2 ? "before" : "after",
        });
      },
      onDrop: (event: DragEvent<HTMLLIElement>) => {
        if (!canArrange) return;
        const row = dailyArrangementRows().find((row) => row.key === key);
        if (!row) return;
        const rect = event.currentTarget.getBoundingClientRect();
        dropTask(
          event,
          row.dayPeriod,
          key,
          event.clientY < rect.top + rect.height / 2 ? "before" : "after",
        );
      },
    };
  }
  function dragClass(key: string) {
    return `${draggingId === key ? " is-dragging" : ""}${dropTarget?.planId === key ? " drop-" + dropTarget.position : ""}`;
  }
  function habitTaskRow(row: HabitRow) {
    const key = `habit:${row.habit.id}`;
    return (
      <DailyHabitTask
        key={key}
        row={row}
        disabled={planLocked || dailyHabits.future}
        selected={selectedHabitId === row.habit.id}
        detailsDisabled={detailBusy || detailDirty || planningBusy || inboxBusy}
        onDetails={() => {
          setSelectedId(null);
          setSelectedHabitId(
            selectedHabitId === row.habit.id ? null : row.habit.id,
          );
        }}
        dragProps={rowDragProps(key)}
        dragClass={dragClass(key)}
        onMoveKeyDown={(event) => moveWithKeyboard(event, key)}
        onToggle={() => {
          void dailyHabits.toggle(row);
        }}
      />
    );
  }
  function taskRow(item: DailyTask, reasons: string[] = []) {
    const description = noteCardText(item.notes ?? "");
    const canArrange =
      desktopAvailable &&
      ["todo", "in_progress", "blocked"].includes(item.status);
    const targeted = dropTarget?.planId === item.planId;
    return (
      <li
        key={item.planId}
        data-plan-id={item.planId}
        data-completion-row=""
        className={`task-item${item.status === "completed" ? " completed" : ""}${draggingId === item.planId ? " is-dragging" : ""}${targeted ? " drop-" + dropTarget.position : ""}`}
        {...rowDragProps(item.planId, canArrange)}
      >
        {canArrange && (
          <button
            className="task-drag-handle"
            disabled={planLocked}
            aria-label={`拖动排序：${item.title}`}
            aria-describedby="task-sort-help"
            title="拖动排序；方向键调整顺序与时段"
            onKeyDown={(event) => moveWithKeyboard(event, item.planId)}
          >
            <svg viewBox="0 0 16 20" aria-hidden="true">
              <path d="M5 4h.01M11 4h.01M5 10h.01M11 10h.01M5 16h.01M11 16h.01" />
            </svg>
          </button>
        )}
        {desktopAvailable && (
          <TaskCompletionButton
            completed={item.status === "completed"}
            busy={changingId === item.taskId}
            title={item.title}
            disabled={
              changingId !== null ||
              planningBusy ||
              detailBusy ||
              detailDirty ||
              pendingPlan !== null
            }
            onToggle={() => {
              void changeStatus(item);
            }}
          />
        )}
        <button
          disabled={detailBusy || detailDirty || planningBusy || inboxBusy}
          className={
            selectedId === item.taskId ? "task-row selected" : "task-row"
          }
          onClick={() => {
            setSelectedHabitId(null);
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
              <TaskCompletionTitle taskId={item.taskId}>{item.title}</TaskCompletionTitle>
            </span>
            {description && <span className="task-card-note">{description}</span>}
            <span className="task-meta">
              {reasons
                .filter((reason) => reason !== "当日安排")
                .map((reason) => (
                  <span className="timeline-reason" key={reason}>
                    {reason}
                  </span>
                ))}
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
      </li>
    );
  }

  function renderDailyView(content?: TodayContent) {
    const timeline = content
      ? dayTimeline(
          content.data,
          items,
          displayedDate,
          content.now,
          content.zone,
        )
      : null;
    const recommendations = content
      ? recommendBacklog(
          content.data,
          items,
          displayedDate,
          content.zone,
        )
      : [];
    const projectNames = new Map(
      (content?.data.projects ?? []).map((p) => [p.id, p.name]),
    );
    return (
      <div className="today-content">
        <header className={content ? "sr-only" : "day-toolbar"}>
          <h1 id="today-title" className="sr-only">
            {recoveryDate ? "日程安排" : "今日"}
          </h1>
          {!content && (
            <DateStrip
              date={displayedDate}
              today={day.date}
              onSelect={selectDate}
              disabled={planLocked}
            />
          )}
        </header>
        <form
          className="capture-form"
          onSubmit={(event) => {
            void capture(event);
          }}
          aria-label={`添加 ${displayedDate} 的任务`}
        >
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
            placeholder={`添加${displayedDate === day.date ? "今日" : displayedDate}任务，按回车保存`}
            autoComplete="off"
            disabled={
              saving ||
              planningBusy ||
              inboxBusy ||
              detailDirty ||
              !nativeAvailable
            }
            aria-invalid={Boolean(saveError)}
            aria-describedby={saveError ? "save-error" : undefined}
          />
          {(saving || pendingDate) && (
            <span className="capture-status" role="status">
              {saving ? "保存中…" : "按回车重试"}
            </span>
          )}
        </form>
        {!loading && recommendations.length > 0 && (
          <section
            className="timeline-attention today-recommendations"
            aria-label="推荐候选"
          >
            <h2>
              推荐 <span>{recommendations.length}</span>
            </h2>
            <ul className="task-suggestions">
              {recommendations.map((row) => {
                const projectName = row.task.projectId ? projectNames.get(row.task.projectId) : null;
                const attention = row.reasons.find((reason) => ["已逾期", "今日截止", "即将截止", "到期跟进", "P1"].includes(reason));
                return (
                <li key={row.task.id} data-task-id={row.task.id}>
                  <span className="task-suggestion-title" title={row.task.title}>
                    {row.task.title}
                    {projectName && projectName.trim() !== row.task.title.trim() && (
                      <small> · {projectName}</small>
                    )}
                  </span>
                  {attention && <span className="task-suggestion-reason">{attention}</span>}
                  <button
                    type="button"
                    className="accept-suggestion"
                    disabled={planLocked || !desktopAvailable}
                    aria-label={`加入${displayedDate === day.date ? "今日" : displayedDate}：${row.task.title}`}
                    onClick={() =>
                      void acceptSuggestion(row.task, content!.zone)
                    }
                  >
                    {acceptingSuggestion === row.task.id
                      ? "加入中…"
                      : displayedDate === day.date
                        ? "加入今日"
                        : "加入当天"}
                  </button>
                </li>
                );
              })}
            </ul>
          </section>
        )}
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
              const arrangements = orderedDayItems(
                dailyArrangementRows(),
                period,
              );
              const independent = timeline?.periods[period] ?? [];
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
                      {periodTitles[period]}{" "}
                      <span>{arrangements.length + independent.length}</span>
                    </h2>
                  </div>
                  <ul className="task-list">
                    {arrangements.map((row) =>
                      row.task
                        ? taskRow(
                            row.task,
                            timeline?.reasons.get(row.task.taskId),
                          )
                        : habitTaskRow(row.habit!),
                    )}
                    {independent.map((row) => (
                      <li key={row.task.id} className="timeline-independent">
                        {content!.renderTask(row.task, row.reasons)}
                      </li>
                    ))}
                  </ul>
                  {arrangements.length + independent.length === 0 && (
                    <p className="period-empty">
                      {draggingId ? "拖到这里安排" : "此时段暂无任务"}
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
                    pendingPlan.habitChanges,
                  );
                }}
              >
                重试保存排序与星标
              </button>
            )}
            <button
              disabled={planningBusy}
              onClick={() => {
                void Promise.all([
                  refresh(displayedDate),
                  dailyHabits.refresh(),
                ]).catch((e) => setChangeError(message(e)));
                setChangeError("");
                setPendingPlan(null);
              }}
            >
              重新读取
            </button>
          </div>
        )}
        {dailyHabits.error && (
          <p className="error" role="alert">
            {dailyHabits.error}
          </p>
        )}
        {!loading &&
          !loadError &&
          completedItems.length + completedHabits.length > 0 && (
            <section className="completed-section" aria-label="已完成任务">
              <button
                className="completed-heading"
                aria-expanded={showCompleted}
                onClick={() => setShowCompleted(!showCompleted)}
              >
                {showCompleted ? "⌄" : "›"} 已完成 ·{" "}
                {completedItems.length + completedHabits.length}
              </button>
              {showCompleted && (
                <ul className="task-list">
                  {completedItems.map((task) => taskRow(task))}
                  {completedHabits.map((row) => (
                    <DailyHabitTask
                      key={row.habit.id}
                      row={row}
                      disabled={planLocked || dailyHabits.future}
                      selected={selectedHabitId === row.habit.id}
                      detailsDisabled={
                        detailBusy || detailDirty || planningBusy || inboxBusy
                      }
                      onDetails={() => {
                        setSelectedId(null);
                        setSelectedHabitId(
                          selectedHabitId === row.habit.id
                            ? null
                            : row.habit.id,
                        );
                      }}
                      onToggle={() => {
                        void dailyHabits.toggle(row);
                      }}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}
      </div>
    );
  }

  if (accountOpen)
    return (
      <AccountPage
        onBack={() => setAccountOpen(false)}
        initialSection={settingsSection}
        revision={projectRevision}
        onOpenProject={(id) => {
          setAccountOpen(false);
          openProject(id);
        }}
      />
    );
  return (
    <main
      className="workspace reference-workspace todoist-workspace modern-workspace"
      ref={workspaceRef}
    >
      <aside className="sidebar">
        <a className="brand" href="#todos" aria-label="Praxis 首页" onClick={event=>{event.preventDefault();openTodos();}}>
          <span className="brand-mark">P</span>Praxis
          <span className="brand-dot">.</span>
        </a>
        <nav aria-label="主导航">
          {desktopAvailable && <button type="button" className={view==="day" ? "nav-item active" : "nav-item"} aria-current={view==="day" ? "page" : undefined} disabled={projectBusy || detailBusy || planningBusy || inboxBusy || detailDirty} onClick={()=>selectDate(localDay(day.timeZone).date)}><TaskPanelIcon name="sun" />今日</button>}
          <button type="button" className={view==="todos" ? "nav-item active" : "nav-item"} aria-current={view==="todos" ? "page" : undefined} disabled={projectBusy || detailBusy || planningBusy || inboxBusy || detailDirty || (view==="day" && planLocked)} onClick={openTodos}><TaskPanelIcon name="check" />杂事</button>
        </nav>
        {desktopAvailable && (
          <ProjectNavigation
            revision={projectRevision}
            disabled={
              projectBusy ||
              detailBusy ||
              planningBusy ||
              inboxBusy ||
              detailDirty ||
              (view === "day" && planLocked)
            }
            selectedId={
              view === "projects" && projectForm !== "new" ? projectId : null
            }
            overviewSelected={
              view === "projects" && projectId === null && projectForm === null
            }
            onSelect={openProject}
            onList={() => openProject(null)}
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
          <div className="sidebar-bottom">
            <button
              className="sidebar-settings"
              disabled={projectBusy || detailBusy || planningBusy || inboxBusy}
              onClick={openSettings}
            >
              <ProjectIcon name="settings" />
              设置
            </button>
            <LanSyncStatus onRefresh={synced} />
            <AccountButton disabled={projectBusy || detailBusy || planningBusy || inboxBusy || detailDirty || (view === "day" && planLocked)} onClick={() => { setSettingsSection("account"); setAccountOpen(true); }} />
          </div>
        )}
      </aside>
      {view === "todos" ? (
        <PersonalTodoHome revision={projectRevision} externalBusy={detailBusy || detailDirty || personalAgent!==null} onBusyChange={setInboxBusy} onOpenProject={openProject} focusRevision={captureFocusRevision} onChanged={projectsChanged} onOpenAgent={()=>setPersonalAgent({mode:"next"})} />
      ) : view === "day" && desktopAvailable ? (
        <ProductivityView
          renderToday={renderDailyView}
          dailyNavigation={
            <DateStrip
              date={displayedDate}
              today={day.date}
              onSelect={selectDate}
              disabled={planLocked}
            />
          }
          dailyDate={displayedDate}
          dailyRevision={items
            .map((task) =>
              [task.taskId, task.version, task.status, task.isFocus].join(":"),
            )
            .join("|")}
          externalBusy={
            planningBusy ||
            detailBusy ||
            detailDirty ||
            saving ||
            pendingPlan !== null
          }
          onTabChange={handleTimelineTab}
          onZoneChange={applyWorkspaceZone}
          initialTab={workStartTab}
          initialProjectId={workProjectId}
          initialReviewId={workReviewId}
          searchRevision={workSearchRevision}
          onChanged={workChanged}
          onBusyChange={setInboxBusy}
          onTaskCreated={taskCreated}
        />
      ) : view === "projects" ? (
        <ProjectsView
          onOpenPersonalAgent={(mode,projectId)=>setPersonalAgent({mode,projectId})}
          form={projectForm}
          onFormChange={setProjectForm}
          navigationRevision={projectNavigation}
          onBusyChange={setProjectBusy}
          selectedId={projectId}
          onSelect={setProjectId}
          onProjectsChanged={projectsChanged}
          onSettings={openSettings}
        />
      ) : view === "inbox" && !desktopAvailable ? (
        <MobileCaptureView onBusyChange={setInboxBusy} />
      ) : view === "inbox" ? (
        <InboxView
          revision={projectRevision}
          focusRevision={captureFocusRevision}
          onBusyChange={setInboxBusy}
          onScheduled={(date) => {
            setSelectedId(null);
            setView("day");
            setRecoveryDate(date === localDay(day.timeZone).date ? null : date);
            void refresh(date);
          }}
        />
      ) : (
        <section
          className="today reference-day"
          id="today"
          aria-labelledby="today-title"
        >
          {renderDailyView()}
        </section>
      )}
      {selected &&
        view === "day" &&
        timelineTab === "today" &&
        desktopAvailable && (
          <TaskDetailPanel
            scheduleTimeZone={day.timeZone}
            key={selected.taskId + ":" + editorRevision}
            task={
              editBaseline?.taskId === selected.taskId ? editBaseline : selected
            }
            onSaved={showEdited}
            onPersisted={async () => {
              const rows = await refresh(displayedDate);
              const current = rows?.find(
                (task) => task.taskId === selected.taskId,
              );
              if (current) setEditBaseline(current);
            }}
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
      {selectedHabit &&
        view === "day" &&
        timelineTab === "today" &&
        desktopAvailable && (
          <HabitDetailPanel
            row={selectedHabit}
            date={displayedDate}
            onClose={() => setSelectedHabitId(null)}
          />
        )}
      {personalAgent && <PersonalAgentPanel {...personalAgent} onClose={()=>setPersonalAgent(null)} onApplied={()=>{projectsChanged();window.dispatchEvent(new Event("praxis-lan-sync"));}} onOpenTask={id=>{setPersonalAgent(null);setWorkTaskId(id);}} />}
      {workTaskId && (
        <ProductivityView
          key={workTaskId}
          editorOnly
          initialTaskId={workTaskId}
          onEditorClosed={() => {
            setWorkTaskId(null);
            projectsChanged();
            window.dispatchEvent(new Event("praxis-task-editor-closed"));
            window.dispatchEvent(new Event("praxis-lan-sync"));
          }}
          onChanged={workChanged}
          onBusyChange={setDetailBusy}
        />
      )}
      <PomodoroDock />
      {view !== "inbox" && (
        <ActionNotice
          message={notice.message}
          actionLabel={
            completionUndo
              ? "撤销"
              : notice.destination === "inbox"
                ? "查看收件箱"
                : "查看日期"
          }
          onAction={
            completionUndo
              ? () => void changeStatus(completionUndo)
              : notice.destination
                ? () =>
                    notice.destination === "inbox"
                      ? openInbox()
                      : selectDate(notice.destination!)
                : undefined
          }
          disabled={
            changingId !== null || planningBusy || inboxBusy || detailBusy
          }
          onDismiss={() => {
            setNotice({ message: "" });
            setCompletionUndo(null);
          }}
        />
      )}
    </main>
  );
}
import "./personal-shell.css";
