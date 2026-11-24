import {
  calendarDate,
  type CaptureCommand,
  type DailyTask,
} from "@praxis/application";
import {
  validateGraph,
  WorkspaceRejectedError,
  workspaceKinds,
  type LanBinding,
  type MobileCapture,
  type MobileStorage,
  type MobileWorkspace,
  type SaveCaptureCommand,
  type WorkspaceCommand,
  type WorkspaceEntity,
  type WorkspaceSnapshot,
} from "@praxis/storage-mobile";

const STORAGE_KEY = "praxis.mobile.preview.v1";
const WORKSPACE_ID = "local";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PreviewOperation {
  operation_id: string;
  payload: string;
  occurred_at: string;
}

interface PreviewStoreState {
  workspaceId: string;
  entities: WorkspaceEntity[];
  operations: PreviewOperation[];
  captures: MobileCapture[];
}

function shiftDay(base: string, days: number): string {
  const value = new Date(`${base}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function createSeedState(now = new Date()): PreviewStoreState {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Shanghai";
  const today = calendarDate(now, timeZone);
  const yesterday = shiftDay(today, -1);
  const twoWeeksLater = shiftDay(today, 14);
  const iso = now.toISOString();

  const settingsId = "10000000-0000-4000-8000-000000000001";
  const projectId = "20000000-0000-4000-8000-000000000001";
  const parentTaskId = "30000000-0000-4000-8000-000000000001";
  const subtask1Id = "30000000-0000-4000-8000-000000000002";
  const subtask2Id = "30000000-0000-4000-8000-000000000003";
  const morningTaskId = "30000000-0000-4000-8000-000000000004";
  const afternoonTaskId = "30000000-0000-4000-8000-000000000005";
  const overdueTodoId = "30000000-0000-4000-8000-000000000006";
  const undatedTodoId = "30000000-0000-4000-8000-000000000007";
  const captureId = "40000000-0000-4000-8000-000000000001";

  const entities: WorkspaceEntity[] = [
    {
      id: settingsId,
      kind: "settings",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: { timeZone },
    },
    {
      id: projectId,
      kind: "project",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        title: "个人网站改版",
        outcome: "完成新版首页结构与案例展示上线",
        dueDate: twoWeeksLater,
        status: "active",
        planVersion: 1,
      },
    },
    {
      id: parentTaskId,
      kind: "task",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        title: "重构首页排版",
        notes: "先定首屏视觉节奏，再查移动端断点",
        status: "todo",
        projectId,
        parentId: null,
        sectionId: null,
        priority: 1,
        tags: [],
        executionDate: null,
      },
    },
    {
      id: subtask1Id,
      kind: "task",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        title: "梳理首屏信息层级",
        notes: "",
        status: "todo",
        projectId,
        parentId: parentTaskId,
        sectionId: null,
        priority: 0,
        tags: [],
        executionDate: null,
        desktop: { task_rank: 0 },
      },
    },
    {
      id: subtask2Id,
      kind: "task",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        title: "完成移动端适配走查",
        notes: "",
        status: "todo",
        projectId,
        parentId: parentTaskId,
        sectionId: null,
        priority: 0,
        tags: [],
        executionDate: null,
        desktop: { task_rank: 1 },
      },
    },
    {
      id: morningTaskId,
      kind: "task",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        title: "补充作品集项目案例",
        notes: "先整理 3 个代表项目的背景与结果",
        status: "in_progress",
        projectId,
        parentId: null,
        sectionId: null,
        priority: 1,
        tags: [],
        executionDate: today,
        dayPeriod: "morning",
        dayRank: 1,
        desktop: { important: 1 },
      },
    },
    {
      id: afternoonTaskId,
      kind: "task",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        title: "去取快递并寄出合同",
        notes: "带好身份证件与回寄地址",
        status: "todo",
        projectId: null,
        parentId: null,
        sectionId: null,
        priority: 2,
        tags: [],
        executionDate: today,
        dayPeriod: "afternoon",
        dayRank: 1,
      },
    },
    {
      id: overdueTodoId,
      kind: "task",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        title: "整理四季度报销发票",
        notes: "合并电子发票 PDF",
        status: "todo",
        projectId: null,
        parentId: null,
        sectionId: null,
        priority: 1,
        tags: [],
        executionDate: null,
        dueDate: yesterday,
      },
    },
    {
      id: undatedTodoId,
      kind: "task",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        title: "调研本地离线备份方案",
        notes: "",
        status: "todo",
        projectId: null,
        parentId: null,
        sectionId: null,
        priority: 0,
        tags: [],
        executionDate: null,
      },
    },
    {
      id: captureId,
      kind: "capture",
      version: 1,
      deleted: false,
      createdAt: iso,
      updatedAt: iso,
      data: {
        rawText: "周末把书房桌面重新理线，顺便测试新买的风扇噪音",
        status: "inbox",
      },
    },
  ];

  return {
    workspaceId: WORKSPACE_ID,
    entities,
    operations: [],
    captures: [],
  };
}

function createMemoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => {
      map.set(key, value);
    },
  };
}

function defaultStorage(): Pick<Storage, "getItem" | "setItem"> {
  if (typeof localStorage !== "undefined") return localStorage;
  return createMemoryStorage();
}

export function createPreviewMobileStorage(
  storage: Pick<Storage, "getItem" | "setItem"> = defaultStorage(),
  clock: () => Date = () => new Date(),
) {
  function readState(): PreviewStoreState {
    try {
      const raw = storage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<PreviewStoreState>;
        if (parsed && Array.isArray(parsed.entities)) {
          return {
            workspaceId: typeof parsed.workspaceId === "string" ? parsed.workspaceId : WORKSPACE_ID,
            entities: parsed.entities,
            operations: Array.isArray(parsed.operations) ? parsed.operations : [],
            captures: Array.isArray(parsed.captures) ? parsed.captures : [],
          };
        }
      }
    } catch {
      /* Reset corrupt preview state to seed data. */
    }
    const seed = createSeedState(clock());
    writeState(seed);
    return seed;
  }

  function writeState(state: PreviewStoreState) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      /* Ignore storage quota errors in restricted preview sessions. */
    }
  }

  return {
    async workspaceSnapshot(): Promise<WorkspaceSnapshot> {
      const state = readState();
      return {
        workspaceId: state.workspaceId,
        entities: structuredClone(state.entities),
        pendingOperations: 0,
      };
    },

    async workspaceList(): Promise<MobileWorkspace[]> {
      const state = readState();
      return [{ id: state.workspaceId, title: "本地预览工作空间", active: true }];
    },

    async workspaceCommand(command: WorkspaceCommand): Promise<WorkspaceSnapshot> {
      if (
        !UUID_RE.test(command.operationId) ||
        !Number.isFinite(Date.parse(command.occurredAt)) ||
        !Array.isArray(command.changes) ||
        !command.changes.length ||
        command.changes.length > 10000
      )
        throw new WorkspaceRejectedError("操作数据无效。");

      const state = readState();
      if (
        command.expectedWorkspaceId !== undefined &&
        command.expectedWorkspaceId !== state.workspaceId
      )
        throw new WorkspaceRejectedError("AI_STALE_PROJECT");

      const payload = JSON.stringify(command);
      const replay = state.operations.find(
        (op) => op.operation_id === command.operationId,
      );
      if (replay) {
        if (replay.payload !== payload)
          throw new WorkspaceRejectedError("操作编号已用于其他内容或工作空间。");
        return {
          workspaceId: state.workspaceId,
          entities: structuredClone(state.entities),
          pendingOperations: 0,
        };
      }

      const entities = new Map(
        structuredClone(state.entities).map((entity) => [entity.id, entity]),
      );

      if (command.preserveCompletionFact) {
        const rec = command.preserveCompletionFact;
        const current = entities.get(rec.taskId);
        const saved = current?.data._personalUndo as
          | { operationId?: unknown; version?: unknown; before?: Record<string, unknown> }
          | undefined;
        const change = command.changes.find(
          (c) => c.id === rec.taskId && c.kind === "task",
        );
        if (
          !current ||
          current.deleted ||
          !saved ||
          saved.operationId !== rec.operationId ||
          saved.version !== rec.expectedVersion ||
          current.version !== rec.expectedVersion ||
          !change ||
          change.expectedVersion !== rec.expectedVersion ||
          !saved.before ||
          ["status", "waiting", "completedAt", "statusReason"].some(
            (key) =>
              JSON.stringify(change.data[key] ?? null) !==
              JSON.stringify(saved.before![key] ?? null),
          )
        )
          throw new WorkspaceRejectedError("任务已被后续修改，无法恢复原完成事实。");
      }

      if (command.expectedTaskVersions) {
        const expected = new Map(
          command.expectedTaskVersions.map((t) => [t.id, t.version]),
        );
        const liveTasks = [...entities.values()].filter(
          (e) => e.kind === "task" && !e.deleted,
        );
        if (
          expected.size !== liveTasks.length ||
          liveTasks.some((t) => expected.get(t.id) !== t.version)
        )
          throw new WorkspaceRejectedError("任务已变更，请重新预览；当前输入仍保留。");
      }

      if (command.expectedProjectVersions) {
        const expected = new Map(
          command.expectedProjectVersions.map((p) => [p.id, p.version]),
        );
        const liveProjects = [...entities.values()].filter(
          (e) => e.kind === "project" && !e.deleted,
        );
        if (
          expected.size !== liveProjects.length ||
          liveProjects.some((p) => expected.get(p.id) !== p.version)
        )
          throw new WorkspaceRejectedError("项目已变更，请重新预览；当前输入仍保留。");
      }

      const seen = new Set<string>();
      for (const c of command.changes) {
        if (
          !UUID_RE.test(c.id) ||
          !workspaceKinds.includes(c.kind) ||
          !c.data ||
          typeof c.data !== "object" ||
          Array.isArray(c.data) ||
          seen.has(c.id)
        )
          throw new WorkspaceRejectedError("内容格式无效或含重复条目。");
        seen.add(c.id);
        const old = entities.get(c.id);
        if (old ? old.version !== c.expectedVersion || old.kind !== c.kind : c.expectedVersion !== null)
          throw new WorkspaceRejectedError("内容已变更，请重新读取后再保存；当前输入仍保留。");
        entities.set(c.id, {
          id: c.id,
          kind: c.kind,
          version: (old?.version ?? 0) + 1,
          data: structuredClone(c.data),
          deleted: c.deleted ?? false,
          createdAt: old?.createdAt ?? command.occurredAt,
          updatedAt: command.occurredAt,
        });
      }

      const modify = (
        e: WorkspaceEntity,
        data: Record<string, unknown>,
        deleted = e.deleted,
      ) => {
        if (!seen.has(e.id)) {
          e = { ...e, version: e.version + 1, updatedAt: command.occurredAt };
          seen.add(e.id);
        }
        entities.set(e.id, { ...e, data, deleted });
      };

      const deletionQueue = [...entities.values()].filter(
        (e) => seen.has(e.id) && e.deleted,
      );
      for (let i = 0; i < deletionQueue.length; i++) {
        const e = deletionQueue[i]!;
        if (e.kind === "project" || e.kind === "task") {
          for (const child of entities.values()) {
            if (
              !child.deleted &&
              (e.kind === "project"
                ? child.data.projectId === e.id
                : child.data.parentId === e.id)
            ) {
              modify(child, { ...child.data, deletedWith: e.id }, true);
              deletionQueue.push(entities.get(child.id)!);
            }
          }
        }
        if (e.kind === "habit") {
          for (const child of entities.values()) {
            if (!child.deleted && child.kind === "habit_check" && child.data.habitId === e.id)
              modify(child, { ...child.data, deletedWith: e.id }, true);
          }
        }
        if (e.kind === "section") {
          for (const task of entities.values()) {
            if (task.kind === "task" && task.data.sectionId === e.id)
              modify(task, { ...task.data, sectionId: null });
          }
        }
      }

      const restorationQueue = [...entities.values()].filter(
        (e) => seen.has(e.id) && !e.deleted,
      );
      for (let i = 0; i < restorationQueue.length; i++) {
        const e = restorationQueue[i]!;
        for (const child of entities.values()) {
          if (child.deleted && child.data.deletedWith === e.id) {
            const data = { ...child.data };
            delete data.deletedWith;
            modify(child, data, false);
            restorationQueue.push(entities.get(child.id)!);
          }
        }
      }

      const recovered = command.preserveCompletionFact;
      for (const e of [...entities.values()].filter(
        (item) => seen.has(item.id) && !item.deleted,
      )) {
        if (e.kind === "task") {
          if (
            e.data.status === "completed" &&
            [...entities.values()].some(
              (c) =>
                !c.deleted &&
                c.kind === "task" &&
                c.data.parentId === e.id &&
                !["completed", "cancelled"].includes(String(c.data.status)),
            )
          )
            throw new WorkspaceRejectedError("请先完成或取消全部子任务，再完成父任务。");
          const previous = state.entities.find((old) => old.id === e.id);
          if (
            e.data.status === "completed" &&
            !e.data.completedAt &&
            previous?.data.status !== "completed" &&
            recovered?.taskId !== e.id
          )
            modify(e, { ...e.data, completedAt: command.occurredAt });
          else if (e.data.status !== "completed" && e.data.completedAt)
            modify(e, { ...e.data, completedAt: null });
        }
        if (
          e.kind === "project" &&
          e.data.status === "completed" &&
          [...entities.values()].some(
            (t) =>
              !t.deleted &&
              t.kind === "task" &&
              t.data.projectId === e.id &&
              !["completed", "cancelled"].includes(String(t.data.status)),
          )
        )
          throw new WorkspaceRejectedError("请先完成或取消项目中的任务。");
      }

      const nextEntities = [...entities.values()];
      validateGraph(nextEntities);

      const nextState: PreviewStoreState = {
        ...state,
        entities: nextEntities,
        operations: [
          ...state.operations,
          {
            operation_id: command.operationId,
            payload,
            occurred_at: command.occurredAt,
          },
        ].slice(-200),
      };
      writeState(nextState);
      return {
        workspaceId: nextState.workspaceId,
        entities: structuredClone(nextState.entities),
        pendingOperations: 0,
      };
    },

    async workspaceExport(): Promise<string> {
      const state = readState();
      return JSON.stringify({
        format: "praxis-mobile-workspace",
        version: 1,
        workspace: { title: "本地预览工作空间" },
        entities: state.entities,
        history: state.operations,
      });
    },

    async workspaceHistory(): Promise<PreviewOperation[]> {
      return [...readState().operations];
    },

    async entityState(): Promise<Awaited<ReturnType<MobileStorage["entityState"]>>> {
      return {
        active: false,
        binding: undefined,
        cursor: 0,
        lastSuccess: null,
        generation: null,
        rejected: undefined,
        rejectedLocal: [],
        conflicts: [],
      };
    },

    async lanBind(_binding: LanBinding): Promise<void> {},

    async listDay(date: string): Promise<DailyTask[]> {
      const state = readState();
      return state.entities
        .filter(
          (e) =>
            !e.deleted &&
            e.kind === "task" &&
            e.data.executionDate === date &&
            e.data.status !== "cancelled",
        )
        .map((e) => ({
          taskId: e.id,
          planId: e.id,
          title: String(e.data.title ?? ""),
          executionDate: date,
          createdAt: e.createdAt,
          projectId:
            typeof e.data.projectId === "string" ? e.data.projectId : null,
          status: (String(e.data.status ?? "todo") as DailyTask["status"]),
          source: "temporary",
          version: e.version,
          isFocus: false,
          focusRank: 0,
          dayPeriod:
            e.data.dayPeriod === "morning" ||
            e.data.dayPeriod === "afternoon" ||
            e.data.dayPeriod === "evening"
              ? e.data.dayPeriod
              : "morning",
          dayRank: typeof e.data.dayRank === "number" ? e.data.dayRank : 0,
          notes: String(e.data.notes ?? ""),
        }));
    },

    async capture(command: CaptureCommand): Promise<DailyTask> {
      const state = readState();
      const entity: WorkspaceEntity = {
        id: command.taskId,
        kind: "task",
        version: 1,
        deleted: false,
        createdAt: command.occurredAt,
        updatedAt: command.occurredAt,
        data: {
          title: command.title.trim(),
          status: "todo",
          executionDate: command.executionDate,
          dayPeriod: "morning",
          priority: 0,
          tags: [],
        },
      };
      writeState({ ...state, entities: [...state.entities, entity] });
      return {
        taskId: entity.id,
        planId: command.planId,
        title: String(entity.data.title),
        executionDate: command.executionDate,
        createdAt: entity.createdAt,
        projectId: null,
        status: "todo",
        source: "temporary",
        version: 1,
        isFocus: false,
        focusRank: 0,
        dayPeriod: "morning",
        dayRank: 0,
      };
    },

    async saveCapture(command: SaveCaptureCommand): Promise<void> {
      const state = readState();
      const existing = state.captures.find((c) => c.id === command.id);
      const next: MobileCapture = {
        id: command.id,
        rawText: command.rawText,
        version: (existing?.version ?? 0) + 1,
        createdAt: existing?.createdAt ?? command.occurredAt,
        updatedAt: command.occurredAt,
      };
      writeState({
        ...state,
        captures: existing
          ? state.captures.map((c) => (c.id === command.id ? next : c))
          : [next, ...state.captures],
      });
    },

    async listCaptures(): Promise<MobileCapture[]> {
      return [...readState().captures];
    },

    async captureQueueCount(): Promise<number> {
      return 0;
    },
  };
}
