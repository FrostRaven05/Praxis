// Test doubles for isolated browser UI evidence only. Never imported by production code.
import {
  calendarDate,
  dateAfter,
  emptyContent,
} from "../../packages/application/src/index.ts";

export function installFixture(mode) {
  const at = new Date().toISOString(),
    zone = "Asia/Hong_Kong",
    today = calendarDate(new Date(), zone);
  const projectA = crypto.randomUUID(),
    projectB = crypto.randomUUID();
  const task = (title, patch = {}) => ({
    id: crypto.randomUUID(),
    title,
    notes: "原个人说明",
    projectId: null,
    parentId: null,
    sectionId: null,
    status: "todo",
    rawStatus: "todo",
    waiting: false,
    version: 1,
    plan: null,
    deadline: null,
    followUp: null,
    priority: 4,
    important: 0,
    waitingFor: "",
    waitingNote: "",
    completedAt: null,
    createdAt: at,
    rank: 0,
    labels: [],
    ...patch,
  });
  const initial = [
    task("项目甲逾期任务", {
      projectId: projectA,
      deadline: { kind: "date", date: dateAfter(today, -1) },
      plan: { kind: "date", date: today },
    }),
    task("项目乙今日截止", {
      projectId: projectB,
      deadline: { kind: "date", date: today },
    }),
    task("之后的独立任务", {
      deadline: { kind: "date", date: dateAfter(today, 2) },
    }),
    task("没有日期的独立任务"),
    task("未安排到今日的项目任务", { projectId: projectA }),
    task("保留等待状态", {
      projectId: projectB,
      waiting: true,
      waitingFor: "原有反馈",
    }),
    task("保留阻塞原因", {
      status: "blocked",
      rawStatus: "blocked",
      statusReason: "旧原因",
    }),
    task("精确时刻已逾期", {
      deadline: {
        kind: "instant",
        atUtc: new Date(Date.now() - 60000).toISOString(),
        displayTimezone: "America/Los_Angeles",
      },
    }),
    task("历史完成日期未知", { status: "completed", rawStatus: "completed" }),
    task("已取消不进入待办", { status: "cancelled", rawStatus: "cancelled" }),
    task("已删除不进入待办", { deleted: true }),
  ];
  const projects = [
    {
      id: projectA,
      name: "个人项目甲",
      outcome: "保留旧目标",
      targetDate: dateAfter(today, 7),
      priority: 2,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-02T00:00:00Z",
      status: "active",
      version: 1,
      planVersion: 1,
      focused: 0,
      archivedAt: null,
    },
    {
      id: projectB,
      name: "个人项目乙",
      outcome: "",
      targetDate: null,
      priority: 1,
      createdAt: "2026-11-01T00:00:00Z",
      updatedAt: "2026-11-03T00:00:00Z",
      status: "active",
      version: 1,
      planVersion: 1,
      focused: 0,
      archivedAt: null,
    },
  ];
  const accounts = new Map([
    ["account-a", { tasks: initial, projects }],
    [
      "account-b",
      {
        tasks: [task("另一个账号的个人任务", { id: initial[0].id })],
        projects: [],
      },
    ],
  ]);
  const receipts = new Map();
  const statusOperations = new Map();
  const f = {
    mode,
    owner: "account-a",
    today,
    projectA,
    projectB,
    commands: [],
    applies: 0,
    writeFault: null,
    readFault: false,
    readAfterWriteFault: false,
    current: () => accounts.get(f.owner),
    work: () => {
      if (f.readFault) {
        throw Error("合成读取失败，请重试。");
      }
      return structuredClone({
        settings: [{ timeZone: zone, version: 1 }],
        tasks: f.current().tasks.filter((t) => !t.deleted),
        projects: f.current().projects,
        sections: [],
        labels: [],
        days: [],
        legacyPlans: [],
        events: [],
        migrationReport: "",
      });
    },
    account: () => ({
      baseUrl: "https://fixture.personal.test",
      user: {
        id: f.owner,
        email: "synthetic@personal.test",
        displayName: "个人样本",
      },
      expiresAt: null,
    }),
    switchOwner: (owner) => {
      f.owner = owner;
      window.dispatchEvent(new Event("praxis-lan-sync"));
    },
    editVersion: (title) => {
      f.current().tasks.find((t) => t.title === title).version++;
    },
    aiRequest: async (request) =>
      request.method === "GET" && request.path === "/v1/ai/status"
        ? {
            status: 200,
            body: {
              enabled: false,
              model: null,
              provider: null,
              maxInputCharacters: 8000,
            },
          }
        : {
            status: 503,
            body: {
              error: {
                code: "AI_NOT_CONFIGURED",
                message: "隔离样本未配置模型",
              },
            },
          },
    trashSnapshot: () => {
      if (f.readFault) throw Error("合成读取失败，请重试。");
      const entries = (f.current().trash ?? [])
        .filter((b) => !b.restored)
        .map((b) => {
          const t = f.current().tasks.find((t) => t.id === b.taskId),
            expiresAt = new Date(
              Date.parse(b.deletedAt) + 30 * 86400000,
            ).toISOString();
          return {
            id: b.id,
            taskId: b.taskId,
            title: b.title,
            version: t?.version,
            projectId: t?.projectId ?? null,
            targetType: "task",
            taskCount: 1,
            deletedAt: b.deletedAt,
            recoveryStartedAt: b.deletedAt,
            expiresAt,
            canRestore: !!t?.deleted && Date.now() < Date.parse(expiresAt),
          };
        });
      return {
        entries,
        tasks: f
          .current()
          .tasks.filter((t) => !t.deleted)
          .map((t) => ({
            id: t.id,
            title: t.title,
            version: t.version,
            projectId: t.projectId,
            parentTaskId: t.parentId,
            sectionId: t.sectionId,
          })),
        projects: f.current().projects.map((p) => ({
          id: p.id,
          title: p.name,
          version: p.version,
          templateCount: 0,
          linkCount: 0,
        })),
        settings: { recoveryDays: 30, version: 0 },
        recoveryPolicy: "隔离样本：30天恢复窗口",
      };
    },
    save: (command, mobile) => {
      f.commands.push(structuredClone(command));
      const key = f.owner + ":" + command.operationId;
      if (receipts.has(key)) {
        if (receipts.get(key) !== JSON.stringify(command))
          throw Error("Operation reused");
        return;
      }
      if (f.writeFault === "rejected") {
        f.writeFault = null;
        throw Error("STATE_CONFLICT");
      }
      if (mobile) {
        if (
          command.expectedProjectVersions &&
          (command.expectedProjectVersions.length !==
            f.current().projects.length ||
            command.expectedProjectVersions.some(
              (p) =>
                f.current().projects.find((row) => row.id === p.id)?.version !==
                p.version,
            ))
        )
          throw Error("STATE_CONFLICT");
        const basis = command.expectedTaskVersions;
        if (
          basis &&
          (basis.length !==
            f.current().tasks.filter((t) => !t.deleted).length ||
            basis.some(
              (t) =>
                f.current().tasks.find((row) => row.id === t.id)?.version !==
                t.version,
            ))
        )
          throw Error("STATE_CONFLICT");
        // Validate every changed version before applying this synthetic transaction.
        for (const change of command.changes) {
          const values =
            change.kind === "project"
              ? f.current().projects
              : f.current().tasks;
          const original = values.find((t) => t.id === change.id);
          if ((original?.version ?? null) !== change.expectedVersion)
            throw Error("STATE_CONFLICT");
        }
        if (command.preserveCompletionFact) {
          const guard = command.preserveCompletionFact,
            t = f.current().tasks.find((t) => t.id === guard.taskId),
            undo = t?.mobileData?._personalUndo;
          if (
            !undo ||
            undo.operationId !== guard.operationId ||
            undo.version !== guard.expectedVersion ||
            t.version !== guard.expectedVersion
          )
            throw Error("STATE_CONFLICT");
        }
        for (const change of command.changes) {
          if (change.kind === "project") {
            let p = f.current().projects.find((p) => p.id === change.id);
            if ((p?.version ?? null) !== change.expectedVersion)
              throw Error("STATE_CONFLICT");
            if (!p) {
              p = {
                id: change.id,
                version: 0,
                createdAt: command.occurredAt,
                planVersion: 0,
                focused: 0,
                archivedAt: null,
              };
              f.current().projects.push(p);
            }
            Object.assign(p, {
              name: change.data.title,
              outcome: change.data.outcome,
              targetDate: change.data.dueDate,
              status: change.data.status,
              data: structuredClone(change.data),
              version: p.version + 1,
              updatedAt: command.occurredAt,
            });
            continue;
          }
          let t = f.current().tasks.find((t) => t.id === change.id);
          if ((t?.version ?? null) !== change.expectedVersion)
            throw Error("STATE_CONFLICT");
          if (!t) {
            t = task(change.data.title, {
              id: change.id,
              version: 0,
              createdAt: command.occurredAt,
            });
            f.current().tasks.push(t);
          }
          const old = t.status,
            d = change.data;
          Object.assign(t, {
            title: d.title,
            notes: d.notes,
            projectId: d.projectId ?? null,
            parentId: d.parentId ?? null,
            rawStatus: d.status,
            status: d.status,
            waiting: d.waiting === true,
            version: t.version + 1,
            deleted: change.deleted ?? false,
            mobileData: structuredClone(d),
          });
          if (d.desktop && Object.hasOwn(d.desktop, "deadline_value"))
            t.deadline = d.desktop.deadline_value
              ? JSON.parse(d.desktop.deadline_value)
              : null;
          else if (Object.hasOwn(d, "dueDate"))
            t.deadline = d.dueDate ? { kind: "date", date: d.dueDate } : null;
          t.completedAt =
            command.preserveCompletionFact?.taskId === t.id
              ? (d.completedAt ?? null)
              : d.status === "completed"
                ? old === "completed"
                  ? t.completedAt
                  : command.occurredAt
                : null;
        }
      } else if (command.action?.type === "delete") {
        const a = command.action,
          live = f.current().tasks.filter((t) => !t.deleted),
          t = live.find((t) => t.id === a.id);
        if (
          a.targetType !== "task" ||
          !t ||
          t.version !== a.expectedVersion ||
          a.expectedTasks.length !== live.length ||
          a.expectedTasks.some(
            ([id, version]) =>
              live.find((t) => t.id === id)?.version !== version,
          )
        )
          throw Error("STATE_CONFLICT");
        if (live.some((child) => child.parentId === t.id))
          throw Error("USER:旧父任务请在原回收站预览范围");
        t.deleted = true;
        t.version++;
        (f.current().trash ??= []).push({
          id: command.operationId,
          taskId: t.id,
          title: t.title,
          deletedAt: command.occurredAt,
          restored: false,
        });
      } else if (command.action?.type === "restoreChecked") {
        const a = command.action,
          batch = (f.current().trash ?? []).find(
            (b) => b.id === a.batchId && !b.restored,
          ),
          t = f.current().tasks.find((t) => t.id === batch?.taskId);
        if (
          !batch ||
          !t?.deleted ||
          a.expectedDeletedTasks.length !== 1 ||
          a.expectedDeletedTasks[0][0] !== t.id ||
          a.expectedDeletedTasks[0][1] !== t.version
        )
          throw Error("STATE_CONFLICT");
        if (Date.now() >= Date.parse(batch.deletedAt) + 30 * 86400000)
          throw Error("USER:恢复窗口已过期");
        if (
          t.projectId &&
          !f
            .current()
            .projects.some(
              (p) =>
                p.id === t.projectId && p.status === "active" && !p.archivedAt,
            )
        ) {
          t.projectId = null;
          t.parentId = null;
          t.sectionId = null;
        }
        t.deleted = false;
        t.version++;
        batch.restored = true;
      } else if (command.action?.type === "undoStatus") {
        const a = command.action,
          live = f.current().tasks.filter((t) => !t.deleted),
          t = live.find((t) => t.id === a.id),
          saved = statusOperations.get(f.owner + ":" + a.originalOperationId);
        if (
          !t ||
          t.version !== a.expectedVersion ||
          !saved ||
          saved.taskId !== t.id ||
          saved.afterVersion !== t.version ||
          a.expectedTasks.length !== live.length ||
          a.expectedTasks.some(
            ([id, version]) =>
              live.find((t) => t.id === id)?.version !== version,
          )
        )
          throw Error("STATE_CONFLICT");
        Object.assign(t, structuredClone(saved.before), {
          version: t.version + 1,
        });
      } else if (command.projectId) {
        let p = f.current().projects.find((p) => p.id === command.projectId);
        if ((p?.version ?? null) !== command.expectedVersion)
          throw Error("STATE_CONFLICT");
        if (!p) {
          p = {
            id: command.projectId,
            version: -1,
            createdAt: command.occurredAt,
            status: "active",
            planVersion: 0,
            focused: 0,
            archivedAt: null,
          };
          f.current().projects.push(p);
        }
        Object.assign(p, {
          name: command.name,
          outcome: command.outcome,
          targetDate: command.targetDate,
          priority: command.priority,
          version: p.version + 1,
          updatedAt: command.occurredAt,
        });
      } else if (command.action.type === "task") {
        const a = command.action;
        let t = f.current().tasks.find((t) => t.id === a.id);
        if ((t?.version ?? null) !== a.expectedVersion)
          throw Error("STATE_CONFLICT");
        if (!t) {
          if (
            a.projectId &&
            !f
              .current()
              .projects.some(
                (p) =>
                  p.id === a.projectId &&
                  p.status === "active" &&
                  !p.archivedAt,
              )
          )
            throw Error("STATE_CONFLICT");
          t = task(a.title, {
            id: a.id,
            version: 0,
            createdAt: command.occurredAt,
          });
          f.current().tasks.push(t);
        }
        Object.assign(t, {
          title: a.title,
          notes: a.notes,
          projectId: a.projectId,
          plan: a.plan,
          deadline: a.deadline,
          followUp: a.followUp,
          priority: a.priority,
          waitingFor: a.waitingFor,
          waitingNote: a.waitingNote,
          labels: a.labels,
          version: t.version + 1,
        });
      } else {
        const a = command.action,
          t = f.current().tasks.find((t) => t.id === a.id);
        if (!t || t.version !== a.expectedVersion)
          throw Error("STATE_CONFLICT");
        const live = f.current().tasks.filter((t) => !t.deleted);
        if (
          a.expectedTasks &&
          (a.expectedTasks.length !== live.length ||
            a.expectedTasks.some(
              ([id, version]) =>
                live.find((t) => t.id === id)?.version !== version,
            ))
        )
          throw Error("STATE_CONFLICT");
        const before = {
          status: t.status,
          rawStatus: t.rawStatus,
          waiting: t.waiting,
          completedAt: t.completedAt,
          statusReason: t.statusReason ?? null,
        };
        const old = t.status;
        Object.assign(t, {
          status: a.status,
          rawStatus: a.status,
          waiting: false,
          version: t.version + 1,
        });
        t.completedAt =
          a.status === "completed"
            ? old === "completed"
              ? t.completedAt
              : command.occurredAt
            : null;
        statusOperations.set(key, {
          taskId: t.id,
          before,
          afterVersion: t.version,
        });
      }
      receipts.set(key, JSON.stringify(command));
      f.applies++;
      if (f.readAfterWriteFault) {
        f.readAfterWriteFault = false;
        f.readFault = true;
      }
      if (f.writeFault === "unknown") {
        f.writeFault = null;
        throw Error("合成回包丢失");
      }
    },
    mobileSnapshot: () => {
      const work = f.work();
      const entities = [
        ...f.current().tasks.map((t) => ({
          id: t.id,
          kind: "task",
          version: t.version,
          deleted: !!t.deleted,
          createdAt: t.createdAt,
          updatedAt: at,
          data: {
            ...t.mobileData,
            title: t.title,
            notes: t.notes,
            status: t.rawStatus,
            waiting: t.waiting,
            waitingFor: t.waitingFor,
            projectId: t.projectId,
            parentId: t.parentId,
            executionDate: null,
            completedAt: t.completedAt,
            dueDate: t.deadline
              ? t.deadline.kind === "date"
                ? t.deadline.date
                : calendarDate(
                    new Date(t.deadline.atUtc),
                    t.deadline.displayTimezone,
                  )
              : null,
            desktop: {
              deadline_value: t.deadline ? JSON.stringify(t.deadline) : null,
              status_reason: t.statusReason ?? "",
              opaque: "保留",
            },
          },
        })),
        ...work.projects.map((p) => ({
          id: p.id,
          kind: "project",
          version: p.version,
          deleted: false,
          createdAt: p.createdAt ?? at,
          updatedAt: p.updatedAt ?? at,
          data: {
            recoveryNote: "原有恢复卡",
            desktop: { priority: p.priority, opaque: "保留" },
            ...p.data,
            title: p.name,
            status: p.status,
            outcome: p.outcome,
            dueDate: p.targetDate,
            archivedAt: p.archivedAt,
            planVersion: p.planVersion,
            focused: p.focused === 1,
          },
        })),
        {
          id: "19000000-0000-4000-8000-000000000001",
          kind: "settings",
          version: 1,
          deleted: false,
          createdAt: at,
          updatedAt: at,
          data: { timeZone: zone },
        },
      ];
      return { workspaceId: "local", entities, pendingOperations: 0 };
    },
  };
  f.mobileStorage = {
    workspaceSnapshot: async () => f.mobileSnapshot(),
    workspaceList: async () => [
      { id: "local", title: "本机工作空间", active: true },
    ],
    workspaceCommand: async (c) => {
      try {
        f.save(c, true);
      } catch (error) {
        if (error.message === "STATE_CONFLICT") {
          const { WorkspaceRejectedError } =
            await import("../../packages/storage-mobile/src/index.ts");
          throw new WorkspaceRejectedError("任务已变更，请重新读取。");
        }
        throw error;
      }
      return { workspaceId: "local", entities: [], pendingOperations: 0 };
    },
    entityState: async () => ({
      active: false,
      cursor: 0,
      conflicts: [],
      rejected: null,
    }),
    entityPrepare: async () => null,
  };
  window.__todoFixture = f;
  window.isTauri = mode === "desktop";
  if (mode === "desktop")
    window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  if (mode === "desktop")
    window.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main", windowLabel: "main" },
      },
      transformCallback: () => 0,
      unregisterCallback: () => {},
      invoke: async (command, args = {}) => {
        if (command === "account_status") return f.account();
        if (command === "productivity_snapshot") return f.work();
        if (command === "productivity_command")
          return f.save(args.command, false);
        if (command === "trash_snapshot") return f.trashSnapshot();
        if (command === "trash_command") return f.save(args.command, false);
        if (command === "ai_gateway_request") return f.aiRequest(args.request);
        if (command === "save_project") return f.save(args.command, false);
        if (command === "task_details") {
          const t = f
            .current()
            .tasks.find((t) => t.id === args.taskId && !t.deleted);
          if (!t) throw Error("USER:任务不存在");
          return {
            taskId: t.id,
            title: t.title,
            notes: t.notes,
            completionCriteria: t.completionCriteria ?? "",
            important: !!t.important,
            deadline: t.deadline?.kind === "instant" ? t.deadline.atUtc : null,
            deadlineTimeZone:
              t.deadline?.kind === "instant"
                ? t.deadline.displayTimezone
                : null,
            estimatedMinutes: null,
            version: t.version,
            status: t.status,
            projectId: t.projectId,
          };
        }
        if (command === "list_projects")
          return f
            .current()
            .projects.map((p) => ({ ...p, priority: p.priority ?? 1 }));
        if (command === "project_tasks")
          return f
            .current()
            .tasks.filter((t) => !t.deleted && t.projectId === args.projectId)
            .map((t) => ({
              taskId: t.id,
              title: t.title,
              status: t.status,
              version: t.version,
              parentTaskId: t.parentId,
              createdAt: t.createdAt,
              executionDate: null,
              completionDate: null,
            }));
        if (command === "content_snapshot")
          return structuredClone(emptyContent);
        if (command === "habit_snapshot")
          return { date: today, today, timeZone: zone, habits: [] };
        if (command === "day_load")
          return {
            capacityMinutes: null,
            capacityVersion: 0,
            estimatedMinutes: 0,
            unknownCount: 0,
          };
        if (command === "lan_sync_status")
          return {
            state: "unconfigured",
            entityPending: 0,
            entityConflicts: 0,
          };
        if (
          command.includes("list") ||
          command.includes("conflicts") ||
          command.includes("backups")
        )
          return [];
        return null;
      },
    };
  return f;
}
