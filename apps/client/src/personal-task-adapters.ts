import {
  calendarDate,
  createPersonalTasks,
  PersonalTaskScopeError,
  subtree,
  type PersonalTaskBase,
  type PersonalTaskChange,
  type PersonalDeletedTask,
  type WorkSnapshot,
} from "@praxis/application";
import {
  mobilePersonalTaskFields,
  mobilePersonalWork,
  WorkspaceRejectedError,
  type MobileStorage,
  type WorkspaceCommand,
  type WorkspaceSnapshot,
} from "@praxis/storage-mobile";

const rejectedNative = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  // Desktop maps STATE_CONFLICT to these sentences before the client sees it.
  // They are definite refusals: the write did not land, so the old command must not stay stuck.
  return (
    /^(?:STATE_CONFLICT|USER:|Operation reused)/.test(message) ||
    /内容已更新|视图已更新|任务状态已变化|任务已有更新|安排已发生变化|内容已变化/.test(
      message,
    )
  );
};
const versions = (work: WorkSnapshot) =>
  work.tasks.map((t) => [t.id, t.version] as [string, number]);
export function createDesktopPersonalTasks(
  port: {
    read: () => Promise<WorkSnapshot>;
    scope: () => Promise<string>;
    fallbackZone?: () => string;
    send: (command: {
      operationId: string;
      occurredAt: string;
      action: Record<string, unknown>;
    }) => Promise<void>;
    readTrash?: () => Promise<{
      entries: {
        id: string;
        taskId?: string;
        title: string;
        version?: number;
        projectId?: string | null;
        targetType?: string;
        taskCount?: number;
        simpleTask?: number | boolean;
        canRestore?: boolean;
      }[];
    } | null>;
    sendTrash?: (command: {
      operationId: string;
      occurredAt: string;
      action: Record<string, unknown>;
    }) => Promise<void>;
  },
  clock?: () => Date,
) {
  return createPersonalTasks<{
    scopeKey: string;
    channel?: string;
    command: Parameters<typeof port.send>[0];
  }>(
    {
      async read() {
        const scopeKey = await port.scope();
        const [work, deleted] = await Promise.all([
          port.read(),
          port.readTrash?.(),
        ]);
        if ((await port.scope()) !== scopeKey)
          throw Error("账号已变化，请重新读取");
        const trash: PersonalDeletedTask[] = (deleted?.entries ?? [])
          .filter(
            (e) =>
              e.targetType === "task" &&
              e.taskCount === 1 &&
              e.simpleTask !== false &&
              e.simpleTask !== 0 &&
              e.taskId &&
              typeof e.version === "number",
          )
          .map((e) => ({
            id: e.taskId!,
            batchId: e.id,
            title: e.title,
            version: e.version!,
            projectId: e.projectId ?? null,
            canRestore: e.canRestore === true,
          }));
        return {
          scopeKey,
          work,
          trash,
          fallbackZone: port.fallbackZone?.() ?? "UTC",
        };
      },
      prepareCreate(base, draft, operationId, occurredAt) {
        const prepared = {
          scopeKey: base.scopeKey,
          command: {
            operationId,
            occurredAt,
            action: {
              type: "task",
              id: draft.taskId,
              expectedVersion: null,
              title: draft.title,
              notes: draft.notes,
              projectId: draft.projectId,
              plan: null,
              deadline: draft.deadline,
              followUp: null,
              priority: 4,
              waitingFor: "",
              waitingNote: "",
              labels: [],
              arrangeOnCreate: false,
              ...(draft.parentId ? { parentId: draft.parentId } : {}),
            },
          },
        };
        return JSON.parse(JSON.stringify(prepared)) as typeof prepared;
      },
      prepare(
        base: PersonalTaskBase,
        taskId: string,
        change: PersonalTaskChange,
        operationId: string,
        occurredAt: string,
      ) {
        const task = base.work.tasks.find((t) => t.id === taskId)!;
        let action: Record<string, unknown>;
        let channel = "productivity";
        if (change.type === "delete") {
          if (!port.sendTrash) throw Error("请使用原回收站删除任务");
          channel = "trash";
          action = {
            type: "delete",
            targetType: "task",
            id: taskId,
            expectedVersion: task.version,
            mode: "cascade",
            confirmAll: false,
            expectedTasks: versions(base.work),
          };
        } else if (change.type === "restore") {
          if (!port.sendTrash) throw Error("请使用原回收站恢复任务");
          const deleted = base.trash!.find((t) => t.id === taskId)!;
          channel = "trash";
          action = {
            type: "restoreChecked",
            batchId: deleted.batchId,
            expectedDeletedTasks: [[taskId, deleted.version]],
          };
        } else if (change.type === "undoStatus")
          action = {
            type: "undoStatus",
            id: taskId,
            expectedVersion: task.version,
            originalOperationId: change.operationId,
            expectedTasks: versions(base.work),
          };
        else if (change.type === "edit")
          action = {
            type: "task",
            id: taskId,
            expectedVersion: task.version,
            title: change.title ?? task.title,
            notes: change.notes ?? task.notes,
            projectId: task.projectId,
            plan: task.plan,
            deadline:
              change.deadline === undefined ? task.deadline : change.deadline,
            followUp: task.followUp,
            priority: task.priority,
            waitingFor: task.waitingFor,
            waitingNote: task.waitingNote,
            labels: [...task.labels],
          };
        else if (change.type === "status")
          action = {
            type: "status",
            id: taskId,
            expectedVersion: task.version,
            status: change.status,
            confirmRelated: false,
            expectedTasks: versions(base.work),
          };
        else if (change.type === "reorder")
          action = {
            type: "reorder",
            parentId: taskId,
            orderedIds: [...change.orderedIds],
          };
        else
          action = {
            type: "move",
            id: taskId,
            expectedVersion: task.version,
            projectId: change.projectId,
            parentId: null,
            sectionId: null,
            confirmCount: subtree(base.work.tasks, taskId).length,
            expectedTasks: versions(base.work),
          };
        return {
          scopeKey: base.scopeKey,
          channel,
          command: JSON.parse(
            JSON.stringify({ operationId, occurredAt, action }),
          ) as Parameters<typeof port.send>[0],
        };
      },
      async commit(prepared) {
        if ((await port.scope()) !== prepared.scopeKey)
          throw new PersonalTaskScopeError(
            "账号已变化，请返回原账号后重试或重新读取",
          );
        if ("channel" in prepared && prepared.channel === "trash")
          await port.sendTrash!(prepared.command);
        else await port.send(prepared.command);
      },
      rejected: rejectedNative,
    },
    clock,
  );
}

type MobilePort = Pick<
  MobileStorage,
  "workspaceSnapshot" | "workspaceList" | "workspaceCommand"
> & { scope: () => Promise<string>; fallbackZone: () => string };
export function createMobilePersonalTasks(
  port: MobilePort,
  clock?: () => Date,
) {
  const sources = new WeakMap<
    WorkSnapshot,
    { snapshot: WorkspaceSnapshot; workspaceId: string }
  >();
  return createPersonalTasks(
    {
      async read() {
        const account = await port.scope();
        const workspace = (await port.workspaceList()).find(
          (w) => w.active,
        )?.id;
        if (!workspace) throw Error("个人工作空间不存在");
        const snapshot = await port.workspaceSnapshot();
        if (
          snapshot.workspaceId !== workspace ||
          (await port.workspaceList()).find((w) => w.active)?.id !==
            workspace ||
          (await port.scope()) !== account
        )
          throw Error("账号或工作空间已变化，请重新读取");
        const work = mobilePersonalWork(snapshot, port.fallbackZone());
        sources.set(work, { snapshot, workspaceId: workspace });
        const trash: PersonalDeletedTask[] = snapshot.entities
          .filter(
            (e) =>
              e.kind === "task" &&
              e.deleted &&
              !e.data.parentId &&
              !e.data.deletedWith &&
              !snapshot.entities.some(
                (t) => t.kind === "task" && t.data.parentId === e.id,
              ),
          )
          .map((e) => ({
            id: e.id,
            title: String(e.data.title ?? ""),
            version: e.version,
            batchId: String(e.data._personalDeleteId ?? e.id),
            projectId:
              typeof e.data.projectId === "string" ? e.data.projectId : null,
            canRestore: true,
          }));
        return { scopeKey: JSON.stringify([account, workspace]), work, trash };
      },
      prepareCreate(base, draft, operationId, occurredAt) {
        const source = sources.get(base.work);
        if (!source) throw Error("请通过个人任务入口重新读取");
        const parent = draft.parentId
          ? source.snapshot.entities.find(
              (entity) => entity.kind === "task" && entity.id === draft.parentId,
            )
          : undefined;
        const value = draft.deadline;
        const command: WorkspaceCommand = {
          operationId,
          occurredAt,
          expectedWorkspaceId: source.workspaceId,
          expectedProjectVersions: base.work.projects.map((p) => ({
            id: p.id,
            version: p.version,
          })),
          changes: [
            {
              id: draft.taskId,
              kind: "task",
              expectedVersion: null,
              data: {
                title: draft.title,
                notes: draft.notes,
                projectId: draft.projectId,
                parentId: draft.parentId ?? null,
                sectionId: parent?.data.sectionId ?? null,
                status: "todo",
                priority: 0,
                tags: [],
                executionDate: null,
                dueDate:
                  value === null
                    ? null
                    : value.kind === "date"
                      ? value.date
                      : calendarDate(
                          new Date(value.atUtc),
                          value.displayTimezone,
                        ),
                desktop: {
                  deadline_value: value ? JSON.stringify(value) : null,
                  deadline: value?.kind === "instant" ? value.atUtc : null,
                  deadline_time_zone:
                    value?.kind === "instant" ? value.displayTimezone : null,
                },
              },
            },
          ],
        };
        return {
          scopeKey: base.scopeKey,
          command: JSON.parse(JSON.stringify(command)) as WorkspaceCommand,
        };
      },
      prepare(
        base: PersonalTaskBase,
        taskId: string,
        change: PersonalTaskChange,
        operationId: string,
        occurredAt: string,
      ) {
        const source = sources.get(base.work);
        if (!source) throw Error("请通过个人任务入口重新读取");
        const original = source.snapshot.entities.find(
          (e) =>
            e.kind === "task" &&
            (change.type === "restore" || !e.deleted) &&
            e.id === taskId,
        )!;
        let data = { ...original.data };
        const command: WorkspaceCommand = {
          operationId,
          occurredAt,
          expectedWorkspaceId: source.workspaceId,
          changes: [],
        };
        if (change.type !== "edit")
          command.expectedProjectVersions = base.work.projects.map((p) => ({
            id: p.id,
            version: p.version,
          }));
        if (change.type === "status" && change.status !== "completed") {
          let parent = base.work.tasks.find(
            (t) => t.id === original.data.parentId,
          );
          const visited = new Set<string>();
          while (parent && !visited.has(parent.id)) {
            if (["completed", "cancelled"].includes(parent.status))
              throw new WorkspaceRejectedError("请先在兼容入口确认重开父任务");
            visited.add(parent.id);
            parent = base.work.tasks.find((t) => t.id === parent!.parentId);
          }
          const project = base.work.projects.find(
            (p) => p.id === original.data.projectId,
          );
          if (
            project &&
            (["completed", "cancelled", "archived"].includes(project.status) ||
              project.archivedAt)
          )
            throw new WorkspaceRejectedError("请先在兼容入口确认重开项目");
        }
        if (change.type === "undoStatus") {
          const saved = original.data._personalUndo as
            | {
                operationId: string;
                version: number;
                before: Record<string, unknown>;
              }
            | undefined;
          if (
            !saved ||
            saved.operationId !== change.operationId ||
            saved.version !== original.version
          )
            throw new WorkspaceRejectedError(
              "任务已被后续修改，不能覆盖新编辑",
            );
          data = { ...data, ...saved.before, _personalUndo: null };
          command.preserveCompletionFact = {
            taskId,
            operationId: change.operationId,
            expectedVersion: original.version,
          };
        } else if (change.type === "delete") {
          data._personalDeleteId = operationId;
        } else if (change.type === "restore") {
          const project = base.work.projects.find(
            (p) =>
              p.id === data.projectId && p.status === "active" && !p.archivedAt,
          );
          if (data.projectId && !project) {
            data.projectId = null;
            data.parentId = null;
            data.sectionId = null;
          }
          const parent = base.work.tasks.find(
            (t) =>
              t.id === data.parentId &&
              t.projectId === (data.projectId ?? null),
          );
          if (
            data.parentId &&
            (!parent ||
              (["completed", "cancelled"].includes(parent.status) &&
                !["completed", "cancelled"].includes(String(data.status))))
          ) {
            data.parentId = null;
            data.sectionId = null;
          }
        } else if (change.type === "edit") {
          if (change.title !== undefined) data.title = change.title.trim();
          if (change.notes !== undefined) data.notes = change.notes;
          if (change.deadline !== undefined) {
            const value = change.deadline;
            data.dueDate =
              value === null
                ? null
                : value.kind === "date"
                  ? value.date
                  : calendarDate(new Date(value.atUtc), value.displayTimezone);
            const desktop = {
              ...((original.data.desktop as Record<string, unknown>) ?? {}),
            };
            desktop.deadline_value = value ? JSON.stringify(value) : null;
            desktop.deadline = value?.kind === "instant" ? value.atUtc : null;
            desktop.deadline_time_zone =
              value?.kind === "instant" ? value.displayTimezone : null;
            data.desktop = desktop;
          }
        } else if (change.type === "reorder") {
          const live = source.snapshot.entities.filter(
            (entity) =>
              !entity.deleted &&
              entity.kind === "task" &&
              entity.data.parentId === taskId &&
              entity.data.status !== "cancelled",
          );
          const ids = live.map((entity) => entity.id).sort();
          const given = [...change.orderedIds].sort();
          if (
            ids.length !== given.length ||
            ids.some((id, index) => id !== given[index])
          )
            throw new WorkspaceRejectedError("子任务已变化，请重新读取后再排序");
          for (const [rank, id] of change.orderedIds.entries()) {
            const entity = live.find((item) => item.id === id)!;
            const desktop = {
              ...((entity.data.desktop as Record<string, unknown> | undefined) ??
                {}),
              task_rank: rank,
            };
            command.changes.push({
              id,
              kind: "task",
              expectedVersion: entity.version,
              data: { ...entity.data, desktop },
            });
          }
          return {
            scopeKey: base.scopeKey,
            command: JSON.parse(JSON.stringify(command)) as WorkspaceCommand,
          };
        } else if (change.type === "status") {
          const desktop =
            (original.data.desktop as Record<string, unknown>) ?? {};
          const before = {
            status: original.data.status,
            waiting: original.data.waiting ?? false,
            completedAt: Object.hasOwn(original.data, "completedAt")
              ? original.data.completedAt
              : (desktop.completed_at ?? null),
            statusReason:
              original.data.statusReason ?? desktop.status_reason ?? null,
          };
          data = mobilePersonalTaskFields(original.data, {
            status: change.status,
          });
          // Selecting canonical Todo is an explicit exit from the old waiting flag too.
          data.waiting = false;
          data._personalUndo = {
            operationId,
            version: original.version + 1,
            before,
          };
        } else {
          const descendants = subtree(base.work.tasks, taskId);
          const ids = new Set(descendants.map((t) => t.id));
          if (
            (original.data.projectId ?? null) !== change.projectId &&
            source.snapshot.entities.some(
              (e) =>
                !e.deleted &&
                e.kind === "desktop_row" &&
                e.data.table === "task_dependencies" &&
                (ids.has(
                  String((e.data.row as Record<string, unknown>)?.task_id),
                ) ||
                  ids.has(
                    String(
                      (e.data.row as Record<string, unknown>)?.predecessor_id,
                    ),
                  )),
            )
          )
            throw new WorkspaceRejectedError(
              "请先在兼容入口处理跨项目依赖，再移动任务",
            );
          data = {
            ...data,
            projectId: change.projectId,
            parentId: null,
            sectionId: null,
          };
          command.expectedTaskVersions = base.work.tasks.map((t) => ({
            id: t.id,
            version: t.version,
          }));
          for (const child of descendants.filter((t) => t.id !== taskId)) {
            const e = source.snapshot.entities.find((e) => e.id === child.id)!;
            command.changes.push({
              id: e.id,
              kind: "task",
              expectedVersion: e.version,
              data: { ...e.data, projectId: change.projectId, sectionId: null },
            });
          }
        }
        if (["status", "undoStatus", "delete", "restore"].includes(change.type))
          command.expectedTaskVersions = base.work.tasks.map((t) => ({
            id: t.id,
            version: t.version,
          }));
        if (data.status === "waiting") {
          data.status = "todo";
          data.waiting = true;
        }
        command.changes.push({
          id: taskId,
          kind: "task",
          expectedVersion: original.version,
          data,
          deleted: change.type === "delete",
        });
        return {
          scopeKey: base.scopeKey,
          command: JSON.parse(JSON.stringify(command)) as WorkspaceCommand,
        };
      },
      async commit(prepared) {
        const scope = JSON.stringify([
          await port.scope(),
          (await port.workspaceList()).find((w) => w.active)?.id,
        ]);
        if (scope !== prepared.scopeKey)
          throw new PersonalTaskScopeError(
            "账号或工作空间已变化，请返回原作用域后重试",
          );
        await port.workspaceCommand(prepared.command);
      },
      rejected: (error: unknown) => error instanceof WorkspaceRejectedError,
    },
    clock,
  );
}
