import { feedbackMessage } from "../feedback-message";
import "../personal-shell.css";
import "../feedback.css";
import { AccountPage } from "../AccountPanel";
import { PersonalProjectForm } from "../PersonalProjectForm";
import { PersonalAgentPanel } from "../PersonalAgentPanel";
import {
  PersonalProjectList,
  PersonalProjectProgress,
} from "../PersonalProjectList";
import { mobileProjectSave } from "../personal-project-storage";
import { LanSyncPanel } from "./LanSyncPanel";
import { useLanRefresh } from "../useLanRefresh";
import { PersonalTodoHome } from "../PersonalTodoHome";
import { PomodoroDock } from "../PomodoroDock";
import {
  assignPomodoroTask,
  formatPomodoroClock,
  pomodoroChanged,
  pomodoroRemainingMs,
  readPomodoroState,
  writePomodoroState,
  type PomodoroState,
} from "../pomodoro";
import { TaskCompletionButton } from "../TaskCompletionButton";
import { TaskAiInspiration } from "../TaskAiInspiration";
import { NextStepBanner } from "../NextStepBanner";
import {
  computeNextStepHandoff,
  parentToAutoComplete,
  type NextStepHandoff,
} from "../next-step-handoff";
import { recommendBacklog } from "../day-timeline";
import { currentSubtask } from "../current-subtask";
import { noteSubtitle } from "../task-note";
import { useImeSubmit } from "../useImeSubmit";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type {
  WorkspaceEntity,
  WorkspaceSnapshot,
  WorkspaceCommand,
} from "@praxis/storage-mobile";
import {
  WorkspaceRejectedError,
  mobilePersonalTaskFields,
  mobilePersonalWork,
} from "@praxis/storage-mobile";
import {
  autoArrangeDayItems,
  calendarDate,
  dayPeriods,
  dayPeriodLabels,
  defaultPeriodForDate,
  periodForTime,
  personalTaskQuery,
  personalDeadlineDay,
  timeDay,
  timeLabel,
  type DayPeriod,
} from "@praxis/application";
import { App as NativeApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { mobileStorage } from "../mobile-storage";
import { Inbox } from "./Inbox";
import { Extras, type ExtraSection } from "./Extras";
import { MobileDrawer } from "./MobileDrawer";
import { MonthCalendar } from "./MonthCalendar";
import { MobileNavIcon, type MobileIconName } from "./MobileNavIcon";
import {
  mobileScheduledForDate,
  mobileScheduleTaskPatch,
  mobileTaskDayPeriod,
  mobileUnscheduleTaskPatch,
} from "./mobile-day-model";
import { MobileTaskActionSheet, MobileTaskSheet } from "./MobileTaskSheet";
import "./mobile.css";
import "./mobile-polish.css";

const labels: Record<string, string> = {
  tasks: "今日",
  todos: "杂事",
  calendar: "日历",
  projects: "项目",
  stats: "数据复盘",
  settings: "我的",
  inbox: "收件箱",
  habits: "习惯",
  repeat: "重复任务",
  records: "记录",
  review: "回顾",
  search: "搜索与筛选",
  trash: "回收站",
  focus: "专注",
  templates: "策略与决策",
};

const periodTitles: Record<DayPeriod, string> = {
  morning: "早上",
  afternoon: "中午",
  evening: "晚上",
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
  const [accountOpen, setAccountOpen] = useState(false);
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
    [actionTask, setActionTask] = useState<WorkspaceEntity | null>(null),
    [inspireTaskId, setInspireTaskId] = useState<string | null>(null),
    [projectFilter, setProjectFilter] = useState(""),
    [searchQuery, setSearchQuery] = useState("");
  const [basicProject, setBasicProject] = useState(false);
  const [captureTitle, setCaptureTitle] = useState("");
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [dayHandoff, setDayHandoff] = useState<NextStepHandoff | null>(null);
  const [acceptingId, setAcceptingId] = useState<string | null>(null);
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [personalAgent, setPersonalAgent] = useState<{
    mode: "decompose" | "next";
    projectId?: string | undefined;
    initialInput?: string | undefined;
  } | null>(null);
  const [agentTask, setAgentTask] = useState<string | null>(null);
  const [focusOpen, setFocusOpen] = useState(false);
  const [pomodoroState, setPomodoroState] = useState<PomodoroState>(() =>
    readPomodoroState(),
  );
  const [pomodoroNow, setPomodoroNow] = useState(() => Date.now());
  const ime = useImeSubmit();

  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<PomodoroState>).detail;
      setPomodoroState(detail ?? readPomodoroState());
      setPomodoroNow(Date.now());
    };
    window.addEventListener(pomodoroChanged, sync);
    return () => window.removeEventListener(pomodoroChanged, sync);
  }, []);

  useEffect(() => {
    if (focusOpen || pomodoroState.phase.kind !== "running") return;
    const id = window.setInterval(() => {
      setPomodoroNow(Date.now());
    }, 1000);
    return () => window.clearInterval(id);
  }, [focusOpen, pomodoroState.phase.kind]);

  useEffect(() => {
    if (!personalAgent && agentTask) {
      setAgentTask(null);
      void openTodoTask(agentTask);
    }
  }, [personalAgent, agentTask]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [section, projectFilter]);

  useEffect(() => {
    setDayHandoff(null);
    setShowAllRecommendations(false);
  }, [date, section]);

  const saving = useRef(false);
  const menuButton = useRef<HTMLButtonElement>(null);
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
  const personalWork = (() => {
    try {
      return mobilePersonalWork(snapshot, timeZone);
    } catch {
      return null;
    }
  })();
  const personal = (() => {
    try {
      return personalWork ? personalTaskQuery(personalWork) : null;
    } catch {
      return null;
    }
  })();

  const draftActive = useRef(false);
  draftActive.current = !!(
    personalAgent ||
    editing ||
    actionTask ||
    inspireTaskId ||
    childBusy ||
    organizing ||
    saving.current ||
    pending.current
  );

  useEffect(() => {
    const open = () => {
      if (!draftActive.current) setAccountOpen(true);
    };
    window.addEventListener("praxis-open-account", open);
    return () => window.removeEventListener("praxis-open-account", open);
  }, []);

  useEffect(() => {
    const openFocus = () => {
      if (!draftActive.current) setSection("focus");
    };
    window.addEventListener("praxis-pomodoro", openFocus);
    return () => window.removeEventListener("praxis-pomodoro", openFocus);
  }, []);

  async function refresh(background = false, reportFailure = false) {
    if (background && draftActive.current) return;
    const sequence = ++refreshSequence.current;
    try {
      const next = await mobileStorage.workspaceSnapshot();
      if (
        sequence !== refreshSequence.current ||
        (background && draftActive.current)
      )
        return;
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
      if (reportFailure) throw e;
    } finally {
      if (sequence === refreshSequence.current) setLoading(false);
    }
  }

  useLanRefresh(
    () => mobileStorage.workspaceSnapshot(),
    setSnapshot,
    draftActive.current,
    snapshot.workspaceId,
  );

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
    if (accountOpen) {
      window.dispatchEvent(new Event("praxis-account-back"));
      return;
    }
    if (saving.current || pending.current) {
      setError("保存尚未确认，请先重试保存。");
      return;
    }
    if (inspireTaskId) {
      setInspireTaskId(null);
      return;
    }
    if (actionTask) {
      setActionTask(null);
      return;
    }
    const dialog = document.querySelector<HTMLDialogElement>(
      ".pm-dialog[open], .ai-planner-dialog[open], .personal-project-modal[open], .personal-agent-dialog[open]",
    );
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
      personalAgent ||
      saving.current ||
      editing ||
      actionTask ||
      inspireTaskId ||
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
    if (next === "search") setSearchQuery("");
    setSection(next);
    setMenu(false);
    setProjectFilter("");
  }

  async function openTodoTask(taskId: string) {
    if (!canNavigate()) return;
    saving.current = true;
    setBusy(true);
    setError("");
    ++refreshSequence.current;
    try {
      const next = await mobileStorage.workspaceSnapshot();
      const entity = next.entities.find(
        (e) => e.kind === "task" && !e.deleted && e.id === taskId,
      );
      setSnapshot(next);
      if (!entity) throw Error("任务已变化，请刷新后再打开。");
      setEditing(entity);
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "无法打开任务，请重试。",
      );
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function save(
    entity: WorkspaceEntity,
    data: Record<string, unknown>,
    deleted = false,
    options?: { keepEditing?: boolean },
  ): Promise<boolean> {
    if (saving.current) return false;
    saving.current = true;
    setError("");
    setBusy(true);
    try {
      if (entity.kind === "task")
        data = mobilePersonalTaskFields(entity.data, data);
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
            return false;
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
            return false;
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
          return false;
        for (const child of descendants)
          add(child, {
            projectId: data.projectId ?? null,
            sectionId: data.sectionId ?? null,
          });
      }
      let autoCompletedParentId: string | null = null;
      if (
        !deleted &&
        entity.kind === "task" &&
        String(data.status ?? "") === "completed" &&
        text(entity, "status") !== "completed"
      ) {
        autoCompletedParentId = parentToAutoComplete(
          entity.id,
          tasks.map((t) => ({
            id: t.id,
            parentId: typeof t.data.parentId === "string" ? t.data.parentId : null,
            status: text(t, "status"),
          })),
        );
        if (autoCompletedParentId) {
          const parentEntity = tasks.find((t) => t.id === autoCompletedParentId);
          if (parentEntity) {
            add(parentEntity, {
              status: "completed",
              waiting: false,
              completedAt: data.completedAt ?? new Date().toISOString(),
            });
          }
        }
      }
      if (
        pending.current &&
        JSON.stringify(pending.current.changes) !==
          JSON.stringify(command.changes)
      )
        throw new Error("上次保存结果尚未确认，请先重试原内容，再继续修改。");
      pending.current ??= command;
      const next = await mobileStorage.workspaceCommand(pending.current);
      pending.current = null;
      if (!options?.keepEditing) {
        setEditing(null);
      } else if (autoCompletedParentId && editing?.id === autoCompletedParentId) {
        const updatedParent = next.entities.find(
          (e) => e.id === autoCompletedParentId && !e.deleted,
        );
        if (updatedParent) setEditing(updatedParent);
      }
      setActionTask(null);
      setOrganizing(null);
      setSnapshot(next);
      return true;
    } catch (e) {
      if (e instanceof WorkspaceRejectedError) pending.current = null;
      setError(
        e instanceof Error ? e.message : "保存失败，输入已保留，请重试。",
      );
      return false;
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  async function retryPending() {
    if (saving.current || !pending.current) return;
    saving.current = true;
    setError("");
    setBusy(true);
    try {
      await mobileStorage.workspaceCommand(pending.current);
      pending.current = null;
      setEditing(null);
      setActionTask(null);
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

  function create(
    kind: "task" | "project",
    parent?: WorkspaceEntity,
    period?: DayPeriod,
  ) {
    if (!canNavigate()) return;
    setBasicProject(kind === "project");
    setError("");
    const scheduleDate = section === "todos" ? null : date;
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
              executionDate: parent ? null : scheduleDate,
              dayPeriod:
                period ??
                defaultPeriodForDate(
                  scheduleDate ?? date,
                  today,
                  new Date(),
                  timeZone,
                ),
              priority: 0,
              tags: [],
              parentId: parent?.id ?? null,
              projectId: parent?.data.projectId ?? (projectFilter || null),
            }
          : { title: "", status: "active" },
    });
  }

  async function handleQuickCapture(event: FormEvent) {
    event.preventDefault();
    const trimmed = captureTitle.trim();
    if (!trimmed || busy || saving.current || pending.current) return;
    const freshEntity: WorkspaceEntity = {
      id: crypto.randomUUID(),
      kind: "task",
      version: 0,
      deleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: {
        title: trimmed,
        status: "todo",
        executionDate: date,
        dayPeriod: defaultPeriodForDate(
          date,
          today,
          new Date(),
          timeZone,
          trimmed,
        ),
        priority: 0,
        tags: [],
        parentId: null,
        projectId: null,
      },
    };
    const ok = await save(freshEntity, freshEntity.data);
    if (ok) setCaptureTitle("");
  }

  async function toggleTaskCompletion(
    task: WorkspaceEntity,
    options?: { keepEditing?: boolean },
  ) {
    if (saving.current || pending.current) return;
    const completing = text(task, "status") !== "completed";
    setTogglingId(task.id);
    try {
      const ok = await save(
        task,
        {
          ...task.data,
          status: completing ? "completed" : "todo",
          completedAt: completing ? new Date().toISOString() : null,
        },
        false,
        options,
      );
      if (ok && completing && personalWork) {
        const handoff = computeNextStepHandoff(
          task.id,
          personalWork,
          date,
          timeZone,
        );
        if (handoff && handoff.kind !== "complete_parent") setDayHandoff(handoff);
      } else if (ok && !completing) {
        setDayHandoff(null);
      }
    } finally {
      setTogglingId(null);
    }
  }

  async function scheduleTaskIdForDate(
    taskId: string,
    targetDate = date,
    period?: DayPeriod,
  ) {
    const entity = tasks.find((t) => t.id === taskId);
    if (!entity) return;
    const resolvedPeriod =
      period ??
      defaultPeriodForDate(
        targetDate,
        today,
        new Date(),
        timeZone,
        text(entity, "title"),
      );
    setAcceptingId(taskId);
    try {
      await save(
        entity,
        mobileScheduleTaskPatch(entity, targetDate, resolvedPeriod),
      );
    } finally {
      setAcceptingId(null);
    }
  }

  async function autoArrangeMobileDay() {
    if (busy || childBusy || saving.current || pending.current) return;
    const activeEntities = [
      ...scheduled.periods.morning,
      ...scheduled.periods.afternoon,
      ...scheduled.periods.evening,
    ];
    if (!activeEntities.length) return;
    const movements = autoArrangeDayItems(
      activeEntities.map((entity) => ({
        key: entity.id,
        title: text(entity, "title"),
        dayPeriod: mobileTaskDayPeriod(entity, date, entities),
        dayRank:
          typeof entity.data.dayRank === "number" ? entity.data.dayRank : 0,
        createdAt: entity.createdAt,
        priority:
          typeof entity.data.priority === "number" ? entity.data.priority : 0,
        inProgress: text(entity, "status") === "in_progress",
      })),
      {
        date,
        today,
        now: new Date(),
        timeZone,
      },
    );
    if (!movements.length) {
      setError("");
      return;
    }
    const byId = new Map(activeEntities.map((entity) => [entity.id, entity]));
    for (const movement of movements) {
      const entity = byId.get(movement.key);
      if (!entity) continue;
      const ok = await save(
        entity,
        {
          ...entity.data,
          dayPeriod: movement.dayPeriod,
          dayRank: movement.dayRank,
        },
        false,
      );
      if (!ok) break;
    }
  }

  async function addSubtaskInline(parent: WorkspaceEntity, title: string) {
    const freshSubtask: WorkspaceEntity = {
      id: crypto.randomUUID(),
      kind: "task",
      version: 0,
      deleted: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      data: {
        title,
        status: "todo",
        executionDate: null,
        priority: 0,
        tags: [],
        parentId: parent.id,
        projectId: parent.data.projectId ?? null,
        sectionId: parent.data.sectionId ?? null,
      },
    };
    const ok = await save(freshSubtask, freshSubtask.data, false, {
      keepEditing: true,
    });
    if (!ok) throw new Error("添加子任务失败，请重试。");
  }

  function startPomodoroFor(task: { id: string; title: string }) {
    const next = assignPomodoroTask(readPomodoroState(), task, Date.now());
    writePomodoroState(next);
    setPomodoroState(next);
    setPomodoroNow(Date.now());
    setEditing(null);
    setActionTask(null);
    setInspireTaskId(null);
    setDayHandoff(null);
    setFocusOpen(true);
  }

  const monday = shifted(
    date,
    -((new Date(`${date}T12:00:00`).getDay() + 6) % 7),
  );
  const days = Array.from({ length: 7 }, (_, i) => shifted(monday, i));
  const dayHasTasks = days.map((d) =>
    tasks.some(
      (t) =>
        text(t, "status") !== "cancelled" &&
        (text(t, "executionDate") === d ||
          (text(t, "status") === "completed" &&
            Boolean(t.data.completedAt) &&
            calendarDate(new Date(text(t, "completedAt")), timeZone) === d)),
    ),
  );

  const scheduled = mobileScheduledForDate(entities, date, timeZone);
  const recommendations =
    section === "tasks" && personalWork
      ? recommendBacklog(personalWork, scheduled.dailyTasks, date, timeZone, 30)
      : [];
  const projectNames = new Map(
    projects.map((p) => [p.id, text(p, "title")]),
  );

  const calendarVisible = tasks.filter(
    (t) =>
      (text(t, "executionDate") === date ||
        (personal
          ? personalDeadlineDay(personal.task(t.id)?.deadline ?? null)
          : text(t, "dueDate")) === date) &&
      text(t, "status") !== "cancelled",
  );

  const totalScheduledCount =
    scheduled.periods.morning.length +
    scheduled.periods.afternoon.length +
    scheduled.periods.evening.length;

  function renderDayTaskRow(task: WorkspaceEntity) {
    const projected = personal?.task(task.id);
    const completed = text(task, "status") === "completed";
    const desktopMeta =
      task.data.desktop && typeof task.data.desktop === "object"
        ? (task.data.desktop as Record<string, unknown>)
        : {};
    const important = Boolean(desktopMeta.important);
    const subtitle = noteSubtitle(text(task, "notes"));
    const objective = personalWork
      ? currentSubtask(personalWork.tasks, task.id)
      : null;
    const projectTitle =
      typeof task.data.projectId === "string"
        ? projectNames.get(task.data.projectId)
        : "";
    const deadlineText = projected?.deadline
      ? `截止 ${timeLabel(
          projected.deadline,
          projected.deadline.kind === "instant"
            ? projected.deadline.displayTimezone
            : personal?.timeZone ?? timeZone,
        )}`
      : !personal && text(task, "dueDate")
        ? `截止 ${text(task, "dueDate")}`
        : "";
    const metaParts = [
      task.data.priority ? `P${task.data.priority}` : "",
      projected?.legacy
        ? projected.label
        : !personal && task.data.waiting
          ? "等待跟进"
          : "",
      deadlineText,
      projectTitle,
    ].filter(Boolean);

    return (
      <li
        key={task.id}
        className={`pm-day-task${completed ? " is-complete" : ""}`}
      >
        <TaskCompletionButton
          completed={completed}
          busy={togglingId === task.id}
          title={text(task, "title")}
          disabled={busy || childBusy || Boolean(pending.current)}
          onToggle={() => void toggleTaskCompletion(task)}
        />
        <button
          type="button"
          className="pm-day-task-main"
          disabled={busy || Boolean(pending.current)}
          onClick={() => {
            if (canNavigate()) {
              setError("");
              setBasicProject(false);
              setEditing(task);
            }
          }}
        >
          <span className="pm-day-task-title">
            {important && (
              <span className="task-important" aria-label="重要任务">
                重要
              </span>
            )}
            <span className="pm-day-task-text">{text(task, "title")}</span>
            {objective && (
              <span className="task-next-subtask" title={objective.title}>
                当前 · {objective.title}
              </span>
            )}
          </span>
          {subtitle && <span className="pm-day-task-note">{subtitle}</span>}
          {metaParts.length > 0 && (
            <span className="pm-day-task-meta">{metaParts.join(" · ")}</span>
          )}
        </button>
        {!completed && (
          <button
            type="button"
            className="pm-day-task-focus"
            aria-label={`专注执行：${text(task, "title")}`}
            disabled={busy || childBusy || Boolean(pending.current)}
            onClick={() =>
              startPomodoroFor({ id: task.id, title: text(task, "title") })
            }
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="13" r="7" />
              <path d="M12 9.5V13l2.2 1.5" />
              <path d="M5.5 4.5 3 7M18.5 4.5 21 7" />
            </svg>
          </button>
        )}
      </li>
    );
  }

  if (accountOpen)
    return <AccountPage onBack={() => setAccountOpen(false)} accountOnly />;

  const activeProject = projectFilter
    ? projects.find((p) => p.id === projectFilter)
    : null;
  const headerTitle =
    section === "projects" && activeProject
      ? text(activeProject, "title") || "项目"
      : labels[section];
  const isDailySection = section === "tasks" || section === "todos";

  return (
    <div className="pm-app">
      {personalAgent && (
        <PersonalAgentPanel
          {...personalAgent}
          onClose={() => setPersonalAgent(null)}
          onApplied={() => void refresh()}
          onOpenTask={(id) => {
            setPersonalAgent(null);
            setAgentTask(id);
          }}
          onOpenProject={(id) => {
            setPersonalAgent(null);
            setProjectFilter(id);
            setSection("projects");
          }}
          onStartPomodoro={(task) => {
            setPersonalAgent(null);
            startPomodoroFor(task);
          }}
          onScheduleToday={async (taskId) => {
            await scheduleTaskIdForDate(taskId, date);
          }}
        />
      )}
      {inspireTaskId && (
        <TaskAiInspiration
          taskId={inspireTaskId}
          onClose={() => setInspireTaskId(null)}
          onChanged={() => void refresh()}
          onStartedPomodoro={() => {
            setInspireTaskId(null);
            setSection("focus");
          }}
        />
      )}
      {!personal && (
        <p role="alert" className="pm-error">
          部分日期暂时无法读取，请在原任务中检查。任务内容已保留。
        </p>
      )}
      <header className="pm-header">
        <div className={isDailySection ? "pm-top pm-top-daily" : "pm-top"}>
          {section === "projects" && projectFilter ? (
            <button
              type="button"
              aria-label="返回项目列表"
              className="pm-icon"
              disabled={busy || childBusy || Boolean(pending.current)}
              onClick={() => {
                if (canNavigate()) setProjectFilter("");
              }}
            >
              <MobileNavIcon name="back" />
            </button>
          ) : (
            <button
              ref={menuButton}
              type="button"
              aria-label="打开菜单"
              aria-expanded={menu}
              disabled={
                loading ||
                busy ||
                !!pending.current ||
                !!editing ||
                childBusy ||
                !!organizing
              }
              className="pm-icon"
              onClick={() => {
                if (menu || canNavigate()) setMenu(!menu);
              }}
            >
              ☰
            </button>
          )}
          <div className="pm-top-title">
            <span className="pm-brand-chip">
              <span className="pm-brand-mark">P</span>Praxis
              <span className="pm-brand-dot">.</span>
            </span>
            <h1>{headerTitle}</h1>
          </div>
          <div className="pm-top-actions">
            {isDailySection && (
              <button
                type="button"
                className="pm-icon pm-todos-trigger"
                aria-label="杂事"
                aria-current={section === "todos" ? "page" : undefined}
                title="杂事"
                onClick={() => navigate("todos")}
              >
                <MobileNavIcon name="todos" />
              </button>
            )}
            {isDailySection || section === "projects" ? (
              <button
                type="button"
                className="pm-icon pm-ai-trigger"
                aria-label="接下来做什么"
                title="接下来做什么"
                disabled={
                  loading ||
                  busy ||
                  !!pending.current ||
                  !!editing ||
                  childBusy ||
                  !!organizing
                }
                onClick={() => {
                  if (canNavigate())
                    setPersonalAgent({
                      mode: "next",
                      projectId: projectFilter || undefined,
                    });
                }}
              >
                <MobileNavIcon name="sparkle" />
              </button>
            ) : (
              <span className="pm-icon" aria-hidden="true" />
            )}
          </div>
        </div>
        {section === "tasks" && (
          <div className="pm-week-bar">
            <div className="pm-week-title">
              <button
                type="button"
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
              {date !== today && (
                <button
                  type="button"
                  className="pm-today-pill"
                  onClick={() => chooseDate(today)}
                >
                  回到今天
                </button>
              )}
              <button
                type="button"
                aria-label="下一周"
                onClick={() => chooseDate(shifted(date, 7))}
              >
                ›
              </button>
            </div>
            <div className="pm-week">
              {days.map((d, i) => {
                const isSelected = d === date;
                const isTodayCell = d === today;
                return (
                  <button
                    key={d}
                    type="button"
                    className={`${isSelected ? "selected" : ""}${isTodayCell ? " is-today" : ""}`}
                    aria-pressed={isSelected}
                    onClick={() => chooseDate(d)}
                  >
                    <small>{["一", "二", "三", "四", "五", "六", "日"][i]}</small>
                    <b>{Number(d.slice(-2))}</b>
                    <i
                      className={`pm-week-dot${dayHasTasks[i] ? " has-items" : ""}`}
                      aria-hidden="true"
                    />
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </header>
      {menu && (
        <MobileDrawer
          triggerRef={menuButton}
          section={section}
          projectId={projectFilter}
          entities={snapshot.entities}
          today={today}
          timeZone={timeZone}
          onClose={() => setMenu(false)}
          onNavigate={navigate}
          onProject={(id) => {
            if (!canNavigate()) return;
            setSection("projects");
            setProjectFilter(id);
            setMenu(false);
          }}
          onCreateProject={() => {
            if (!canNavigate()) return;
            setMenu(false);
            setSection("projects");
            setProjectFilter("");
            create("project");
          }}
        />
      )}
      {error && (
        <div className="pm-error" role="alert">
          <span>{feedbackMessage(error)}</span>
          {pending.current && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void retryPending()}
            >
              重试原操作
            </button>
          )}
          <button type="button" onClick={() => void refresh()}>
            重新读取
          </button>
        </div>
      )}
      <main className="pm-main">
        {loading ? (
          <p className="pm-empty">正在读取本机数据…</p>
        ) : (
          <>
            {section === "todos" && (
              <PersonalTodoHome
                embedded
                hideComposer
                hideHistory
                revision={snapshot.entities
                  .map((e) => `${e.id}:${e.version}:${e.deleted}`)
                  .join("|")}
                externalBusy={
                  personalAgent !== null ||
                  busy ||
                  editing !== null ||
                  actionTask !== null ||
                  organizing !== null ||
                  pending.current !== null
                }
                onBusyChange={setChildBusy}
                onOpenProject={(id) => {
                  if (canNavigate()) {
                    setProjectFilter(id);
                    setSection("projects");
                  }
                }}
                onChanged={() => void refresh()}
              />
            )}
            {section === "tasks" && (
              <div className="pm-today-view">
                <form
                  className="pm-capture-form"
                  onSubmit={(event) => void handleQuickCapture(event)}
                  aria-label={`添加 ${date} 的任务`}
                >
                  <label className="sr-only" htmlFor="pm-quick-capture">
                    任务标题
                  </label>
                  <input
                    id="pm-quick-capture"
                    value={captureTitle}
                    placeholder={`添加${date === today ? "今日" : date}任务…`}
                    autoComplete="off"
                    disabled={busy || childBusy || Boolean(pending.current)}
                    onChange={(event) => setCaptureTitle(event.target.value)}
                    onCompositionStart={ime.onCompositionStart}
                    onCompositionEnd={ime.onCompositionEnd}
                    onKeyDown={ime.onKeyDown}
                  />
                  {captureTitle.trim() && (
                    <button
                      type="submit"
                      className="pm-capture-submit"
                      disabled={busy || Boolean(pending.current)}
                    >
                      {busy ? "保存中…" : "添加"}
                    </button>
                  )}
                </form>

                {dayHandoff && (
                  <NextStepBanner
                    handoff={dayHandoff}
                    disabled={busy || Boolean(pending.current)}
                    onStartPomodoro={(task) =>
                      startPomodoroFor({ id: task.id, title: task.title })
                    }
                    onScheduleToday={(task) =>
                      scheduleTaskIdForDate(task.id, date)
                    }
                    onCompleteParent={async (task) => {
                      const parent = tasks.find((t) => t.id === task.id);
                      if (parent) await toggleTaskCompletion(parent);
                    }}
                    onOpenTask={(task) => {
                      setDayHandoff(null);
                      void openTodoTask(task.id);
                    }}
                    onDismiss={() => setDayHandoff(null)}
                  />
                )}

                {recommendations.length > 0 && (
                  <section
                    className="pm-recommendations"
                    aria-label="建议任务"
                  >
                    <div className="pm-recommendations-head">
                      <h2>
                        建议任务 <span>{recommendations.length}</span>
                      </h2>
                      <button
                        type="button"
                        className="pm-ai-pill"
                        disabled={busy || childBusy || Boolean(pending.current)}
                        onClick={() => {
                          if (canNavigate())
                            setPersonalAgent({ mode: "next" });
                        }}
                      >
                        ✦ 接下来做什么
                      </button>
                    </div>
                    <ul className="pm-rec-list">
                      {(showAllRecommendations
                        ? recommendations
                        : recommendations.slice(0, 5)
                      ).map((row) => {
                        const projectName = row.task.projectId
                          ? projectNames.get(row.task.projectId)
                          : "杂事";
                        const attention = row.reasons.find((reason) =>
                          [
                            "已逾期",
                            "今日截止",
                            "即将截止",
                            "进行中",
                            "到期跟进",
                            "P1",
                          ].includes(reason),
                        );
                        const keptDate =
                          timeDay(row.actionTask.deadline, timeZone) ??
                          timeDay(row.task.deadline, timeZone) ??
                          timeDay(row.task.plan, timeZone);
                        const hasLeaf = row.actionTask.id !== row.task.id;
                        return (
                          <li key={row.task.id} className="pm-rec-item">
                            <div className="pm-rec-info">
                              <span className="pm-rec-title">
                                {row.task.title}
                                {hasLeaf && (
                                  <span className="task-next-subtask">
                                    当前 · {row.actionTask.title}
                                  </span>
                                )}
                              </span>
                              <span className="pm-rec-meta">
                                {projectName &&
                                  projectName.trim() !==
                                    row.task.title.trim() && (
                                    <span>{projectName}</span>
                                  )}
                                <span>{keptDate ?? "没有日期"}</span>
                                {attention && (
                                  <span className="pm-rec-reason">
                                    {attention}
                                  </span>
                                )}
                              </span>
                            </div>
                            <button
                              type="button"
                              className="pm-rec-accept"
                              disabled={
                                busy ||
                                childBusy ||
                                Boolean(pending.current) ||
                                acceptingId === row.actionTask.id
                              }
                              aria-label={`加入${date === today ? "今日" : date}：${hasLeaf ? row.actionTask.title : row.task.title}`}
                              onClick={() =>
                                void scheduleTaskIdForDate(
                                  row.actionTask.id,
                                  date,
                                )
                              }
                            >
                              {acceptingId === row.actionTask.id
                                ? "加入中…"
                                : date === today
                                  ? "加入今日"
                                  : "加入当天"}
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                    {recommendations.length > 5 && (
                      <button
                        type="button"
                        className="pm-rec-more"
                        onClick={() => setShowAllRecommendations((v) => !v)}
                      >
                        {showAllRecommendations
                          ? "收起建议"
                          : `展开其余 ${recommendations.length - 5} 项`}
                      </button>
                    )}
                  </section>
                )}

                {!focusOpen && pomodoroState.phase.kind !== "idle" && (
                  <button
                    type="button"
                    className="pm-active-focus-bar"
                    onClick={() => setFocusOpen(true)}
                  >
                    <span className="pm-active-focus-dot" aria-hidden="true" />
                    <span className="pm-active-focus-clock">
                      {formatPomodoroClock(
                        pomodoroRemainingMs(pomodoroState, pomodoroNow),
                      )}
                    </span>
                    <span className="pm-active-focus-title">
                      {pomodoroState.task?.title || "专注中"}
                    </span>
                    <span className="pm-active-focus-cta">回到专注</span>
                  </button>
                )}

                <div className="pm-periods-bar">
                  <span className="pm-periods-now">
                    {date === today
                      ? `当前时段 · ${periodTitles[periodForTime(new Date(), timeZone)]}`
                      : `${date} · 早中晚安排`}
                  </span>
                  <button
                    type="button"
                    className="pm-auto-arrange"
                    disabled={
                      busy ||
                      childBusy ||
                      Boolean(pending.current) ||
                      totalScheduledCount === 0
                    }
                    onClick={() => void autoArrangeMobileDay()}
                  >
                    ⏱ 按时间安排早中晚
                  </button>
                </div>

                <div className="pm-periods">
                  {dayPeriods.map((period) => {
                    const periodTasks = scheduled.periods[period];
                    return (
                      <section
                        key={period}
                        className="pm-period-card"
                        aria-label={dayPeriodLabels[period]}
                        data-period={period}
                      >
                        <div className="pm-period-head">
                          <h2>
                            {periodTitles[period]}{" "}
                            <span>{periodTasks.length}</span>
                          </h2>
                          <button
                            type="button"
                            className="pm-period-add"
                            aria-label={`在${periodTitles[period]}添加任务`}
                            disabled={
                              busy || childBusy || Boolean(pending.current)
                            }
                            onClick={() => create("task", undefined, period)}
                          >
                            ＋
                          </button>
                        </div>
                        {periodTasks.length > 0 ? (
                          <ul className="pm-day-task-list">
                            {periodTasks.map((t) => renderDayTaskRow(t))}
                          </ul>
                        ) : (
                          <p className="pm-period-empty">此时段暂无任务</p>
                        )}
                      </section>
                    );
                  })}
                </div>

                {totalScheduledCount === 0 &&
                  scheduled.completed.length === 0 &&
                  recommendations.length === 0 && (
                    <div className="pm-empty">
                      <span>○</span>
                      <h2>给今天留一个明确的下一步</h2>
                      <p>在上方输入任务，或点击右下角快速添加。</p>
                    </div>
                  )}

                {scheduled.completed.length > 0 && (
                  <section
                    className="pm-completed-section"
                    aria-label="已完成任务"
                  >
                    <button
                      type="button"
                      className="pm-completed-toggle"
                      aria-expanded={showCompleted}
                      onClick={() => setShowCompleted((v) => !v)}
                    >
                      {showCompleted ? "⌄" : "›"} 已完成 ·{" "}
                      {scheduled.completed.length}
                    </button>
                    {showCompleted && (
                      <ul className="pm-day-task-list pm-completed-list">
                        {scheduled.completed.map((t) => renderDayTaskRow(t))}
                      </ul>
                    )}
                  </section>
                )}
              </div>
            )}

            {section === "calendar" && (
              <>
                <MonthCalendar
                  date={date}
                  today={today}
                  entities={entities}
                  onChoose={chooseDate}
                />
                <div className="pm-calendar-agenda">
                  <div className="pm-list-heading">
                    <h2>
                      {date === today ? "今天" : date}{" "}
                      <small>{calendarVisible.length} 项</small>
                    </h2>
                    <button
                      type="button"
                      onClick={() => setOrganizing("plan")}
                    >
                      每日安排
                    </button>
                  </div>
                  {calendarVisible.length ? (
                    <ul className="pm-day-task-list">
                      {calendarVisible
                        .filter(
                          (t) =>
                            !calendarVisible.some(
                              (p) => p.id === t.data.parentId,
                            ),
                        )
                        .map((t) => renderDayTaskRow(t))}
                    </ul>
                  ) : (
                    <div className="pm-empty">
                      <span>○</span>
                      <h2>这一天还没有安排</h2>
                      <p>点击右下角添加任务，或从收件箱安排。</p>
                    </div>
                  )}
                </div>
              </>
            )}

            {section === "projects" && (
              <>
                {projectFilter ? (
                  <>
                    <div className="personal-project-detail-summary">
                      {activeProject?.data.outcome ? (
                        <p>{text(activeProject, "outcome")}</p>
                      ) : null}
                      {activeProject?.data.dueDate ? (
                        <small>目标日期 {text(activeProject, "dueDate")}</small>
                      ) : null}
                      <PersonalProjectProgress
                        work={mobilePersonalWork(snapshot, timeZone)}
                        projectId={projectFilter}
                      />
                      <button
                        type="button"
                        className="pm-secondary"
                        disabled={busy || childBusy || !!editing}
                        onClick={() => {
                          if (canNavigate() && activeProject) {
                            setBasicProject(true);
                            setEditing(activeProject);
                          }
                        }}
                      >
                        编辑基本信息
                      </button>
                    </div>
                    <div className="ai-planner-launch-group">
                      <button
                        type="button"
                        className="ai-planner-launch"
                        disabled={
                          busy || childBusy || !!editing || !!organizing
                        }
                        onClick={() => {
                          if (canNavigate())
                            setPersonalAgent({
                              mode: "decompose",
                              projectId: projectFilter,
                            });
                        }}
                      >
                        ✦ 拆成步骤
                      </button>
                      <button
                        type="button"
                        className="ai-planner-launch"
                        disabled={
                          busy || childBusy || !!editing || !!organizing
                        }
                        onClick={() => {
                          if (canNavigate())
                            setPersonalAgent({
                              mode: "next",
                              projectId: projectFilter,
                            });
                        }}
                      >
                        ✦ 下一步
                      </button>
                    </div>
                    <PersonalTodoHome
                      key={projectFilter}
                      projectId={projectFilter}
                      embedded
                      revision={snapshot.entities
                        .map((e) => `${e.id}:${e.version}:${e.deleted}`)
                        .join("|")}
                      externalBusy={
                        personalAgent !== null ||
                        busy ||
                        editing !== null ||
                        actionTask !== null ||
                        organizing !== null ||
                        pending.current !== null
                      }
                      onBusyChange={setChildBusy}
                      onOpenProject={(id) => {
                        if (canNavigate()) setProjectFilter(id);
                      }}
                      onChanged={() => void refresh()}
                    />
                  </>
                ) : (
                  <PersonalProjectList
                    work={mobilePersonalWork(snapshot, timeZone)}
                    disabled={busy || childBusy || !!editing}
                    onOpen={(id) => {
                      if (canNavigate()) setProjectFilter(id);
                    }}
                    onCreate={() => create("project")}
                    onAiCreate={() => {
                      if (canNavigate())
                        setPersonalAgent({ mode: "decompose" });
                    }}
                    onEdit={(id) => {
                      if (canNavigate()) {
                        const target = projects.find((p) => p.id === id);
                        if (target) {
                          setBasicProject(true);
                          setEditing(target);
                        }
                      }
                    }}
                  />
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

            {section === "focus" && <PomodoroDock variant="page" />}

            {![
              "todos",
              "tasks",
              "calendar",
              "projects",
              "inbox",
              "focus",
            ].includes(section) && (
              <Extras
                section={section as ExtraSection}
                searchQuery={searchQuery}
                snapshot={snapshot}
                refresh={refresh}
                onBusyChange={setChildBusy}
                onNavigate={navigate}
              />
            )}
          </>
        )}
        <LanSyncPanel
          refresh={() => refresh(true)}
          visible={false}
        />
      </main>

      {["todos", "tasks", "calendar", "projects"].includes(section) &&
        !editing &&
        !actionTask &&
        !childBusy && (
          <button
            type="button"
            className="pm-fab"
            disabled={busy || childBusy || pending.current !== null}
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
        {(
          [
            ["tasks", "今日", "sun"],
            ["projects", "项目", "projects"],
            ["settings", "我的", "settings"],
          ] as [string, string, MobileIconName][]
        ).map(([key, label, icon]) => {
          const isActive =
            key === "tasks" ? isDailySection : section === key;
          return (
            <button
              key={key}
              type="button"
              className={isActive ? "active" : ""}
              aria-current={isActive ? "page" : undefined}
              onClick={() => navigate(key)}
            >
              <MobileNavIcon name={icon} />
              {label}
            </button>
          );
        })}
      </nav>

      {focusOpen && (
        <PomodoroDock
          variant="overlay"
          onClose={() => {
            setPomodoroState(readPomodoroState());
            setPomodoroNow(Date.now());
            setFocusOpen(false);
          }}
          onCompleteTask={(taskId) => {
            setPomodoroState(readPomodoroState());
            setFocusOpen(false);
            const found = tasks.find((t) => t.id === taskId);
            if (found && text(found, "status") !== "completed") {
              void toggleTaskCompletion(found);
            }
          }}
        />
      )}

      {editing && editing.kind === "project" && basicProject && (
        <PersonalProjectForm
          key={editing.id}
          modal
          initial={
            editing.version
              ? {
                  name: text(editing, "title"),
                  outcome: text(editing, "outcome"),
                  targetDate:
                    typeof editing.data.dueDate === "string"
                      ? editing.data.dueDate
                      : null,
                }
              : null
          }
          createSave={() =>
            mobileProjectSave(editing, snapshot.workspaceId ?? "local")
          }
          onBusyChange={setChildBusy}
          onCancel={() => setEditing(null)}
          onSaved={async (id) => {
            await refresh(false, true);
            setEditing(null);
            setSection("projects");
            setProjectFilter(id);
          }}
        />
      )}

      {editing && !(editing.kind === "project" && basicProject) && (
        <MobileTaskSheet
          key={`${editing.id}:${editing.version}`}
          entity={editing}
          today={today}
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
          onToggleSubtask={(sub) =>
            toggleTaskCompletion(sub, { keepEditing: true })
          }
          onAddSubtask={addSubtaskInline}
          onStartPomodoro={startPomodoroFor}
          onOpenInspiration={(taskId) => {
            setEditing(null);
            setInspireTaskId(taskId);
          }}
        />
      )}

      {actionTask && (
        <MobileTaskActionSheet
          task={actionTask}
          currentPeriod={mobileTaskDayPeriod(actionTask, date, entities)}
          scheduledOnDate={text(actionTask, "executionDate") === date}
          busy={busy}
          onClose={() => setActionTask(null)}
          onChangePeriod={(period) => {
            void save(
              actionTask,
              mobileScheduleTaskPatch(actionTask, date, period),
            );
          }}
          onStartPomodoro={() =>
            startPomodoroFor({
              id: actionTask.id,
              title: text(actionTask, "title") || "未命名任务",
            })
          }
          onOpenInspiration={() => {
            const targetId = actionTask.id;
            setActionTask(null);
            setInspireTaskId(targetId);
          }}
          onAddSubtask={() => {
            const parent = actionTask;
            setActionTask(null);
            setBasicProject(false);
            setEditing({
              id: crypto.randomUUID(),
              kind: "task",
              version: 0,
              deleted: false,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              data: {
                title: "",
                status: "todo",
                executionDate: null,
                priority: 0,
                tags: [],
                parentId: parent.id,
                projectId: parent.data.projectId ?? null,
              },
            });
          }}
          onUnschedule={() => {
            void save(actionTask, mobileUnscheduleTaskPatch(actionTask));
          }}
          onEdit={() => {
            const target = actionTask;
            setActionTask(null);
            setBasicProject(false);
            setEditing(target);
          }}
          onDelete={() => {
            const target = actionTask;
            const title = text(target, "title") || "未命名任务";
            if (window.confirm(`将“${title}”移到回收站？`)) {
              void save(target, target.data, true);
            }
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
            {feedbackMessage(error)}
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
