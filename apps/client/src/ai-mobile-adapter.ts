import { mobileAiContext } from "./ai-context-mobile";
import {
  validateAiProposal,
  uuidPattern,
  type AiApplyCommand,
  type AiApplyReceipt,
} from "../../api/src/ai-contract";
import {
  WorkspaceRejectedError,
  aiRecoveryReadSet,
  type AiRecoveryReadSet,
  type WorkspaceCommand,
  type WorkspaceEntity,
  type WorkspaceSnapshot,
} from "@praxis/storage-mobile";

interface FrozenOutput {
  id: string;
  version: number;
}
export interface MobileAiApplication {
  runId: string;
  command: AiApplyCommand;
  receipt: AiApplyReceipt;
  captureVersion: number;
  outputVersions: FrozenOutput[];
  dependencyRows: FrozenOutput[];
}
export interface MobileAiWrite {
  kind: "apply" | "undo";
  workspace: WorkspaceCommand;
  command: AiApplyCommand | null;
  applyOperationId: string;
}
export interface AiMobilePort {
  snapshot(): Promise<WorkspaceSnapshot>;
  commit(command: WorkspaceCommand): Promise<WorkspaceSnapshot>;
  scope(): Promise<{ key: string; workspaceId: string }>;
  cache: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}
const validId = (value: string) => new RegExp(uuidPattern).test(value);
function fail(code: string): never {
  throw Error(code);
}
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
function applications(entity: WorkspaceEntity): MobileAiApplication[] {
  const history = Array.isArray(entity.data.aiApplications)
    ? entity.data.aiApplications
    : [];
  const current = entity.data.aiApplication;
  return [...history, current].filter(
    (value): value is MobileAiApplication =>
      !!value &&
      typeof value === "object" &&
      typeof (value as MobileAiApplication).receipt?.operationId === "string" &&
      !!(value as MobileAiApplication).command &&
      Array.isArray((value as MobileAiApplication).outputVersions) &&
      Array.isArray((value as MobileAiApplication).dependencyRows),
  );
}
function findApplication(snapshot: WorkspaceSnapshot, operationId: string) {
  for (const capture of snapshot.entities.filter((e) => e.kind === "capture")) {
    const application = applications(capture).find(
      (a) => a.receipt.operationId === operationId,
    );
    if (application) return { capture, application };
  }
  return null;
}
export function mobileAiReceipt(
  snapshot: WorkspaceSnapshot,
  operationId: string,
): AiApplyReceipt | null {
  if (!validId(operationId)) fail("AI_INVALID_COMMAND");
  return findApplication(snapshot, operationId)?.application.receipt ?? null;
}
function checkCommand(command: AiApplyCommand) {
  if (
    !validId(command.operationId) ||
    !validId(command.runId) ||
    !command.input.trim() ||
    command.input.length > 8000 ||
    !command.tasks.length ||
    command.tasks.length > 20 ||
    command.basisTasks.length > 100 ||
    (!!command.project && !!command.newProject) ||
    new Set(command.tasks.map((t) => t.id)).size !== command.tasks.length ||
    command.tasks.some((t) => !validId(t.id))
  )
    fail("AI_INVALID_COMMAND");
  if (
    command.project &&
    (!validId(command.project.id) ||
      !Number.isSafeInteger(command.project.version) ||
      command.project.version < 1 ||
      !Number.isSafeInteger(command.project.planVersion) ||
      command.project.planVersion < 0)
  )
    fail("AI_INVALID_COMMAND");
  if (
    command.source &&
    (!validId(command.source.id) ||
      !Number.isSafeInteger(command.source.version) ||
      command.source.version < 1 ||
      !command.source.rawText.trim() ||
      command.source.rawText.length > 8000)
  )
    fail("AI_INVALID_COMMAND");
  if (command.newProject && !validId(command.newProject.id))
    fail("AI_INVALID_COMMAND");
  if (
    command.basisTasks.some(
      (t) =>
        !validId(t.id) || !Number.isSafeInteger(t.version) || t.version < 1,
    ) ||
    new Set(command.basisTasks.map((t) => t.id)).size !==
      command.basisTasks.length
  )
    fail("AI_INVALID_COMMAND");
  if (
    command.basisRecovery !== undefined &&
    (!command.project ||
      !command.basisRecovery ||
      (command.basisRecovery.version !== null &&
        (!Number.isSafeInteger(command.basisRecovery.version) ||
          command.basisRecovery.version < 0)) ||
      !Array.isArray(command.basisRecovery.records) ||
      command.basisRecovery.records.length > 5 ||
      command.basisRecovery.records.some(
        (record) =>
          !validId(record.id) ||
          !Number.isSafeInteger(record.version) ||
          record.version < 0,
      ) ||
      new Set(command.basisRecovery.records.map((record) => record.id)).size !==
        command.basisRecovery.records.length)
  )
    fail("AI_INVALID_COMMAND");
  try {
    validateAiProposal({
      summary: "用户采用的规划草稿",
      projectName: command.newProject?.name ?? "",
      outcome: command.newProject?.outcome ?? "",
      assumptions: [],
      question: null,
      nextAction: "",
      reward: command.reward,
      suggestedTaskId: null,
      tasks: command.tasks.map(({ id: _, ...task }) => task),
    });
  } catch {
    fail("AI_INVALID_COMMAND");
  }
  if (command.newProject && !command.newProject.name.trim())
    fail("AI_INVALID_COMMAND");
  if (!command.project && command.basisTasks.length) fail("AI_INVALID_COMMAND");
  if (
    !command.project &&
    !command.newProject &&
    command.tasks.some((t) => t.dependsOn.length)
  )
    fail("AI_INVALID_DEPENDENCIES");
  if (command.scheduleToday != null) {
    const plan = command.scheduleToday;
    const validDay =
      typeof plan.date === "string" &&
      /^\d{4}-\d{2}-\d{2}$/.test(plan.date) &&
      Number.isFinite(Date.parse(plan.date + "T12:00:00Z")) &&
      new Date(plan.date + "T12:00:00Z").toISOString().slice(0, 10) ===
        plan.date;
    let validZone =
      typeof plan.timeZone === "string" &&
      plan.timeZone.trim().length > 0 &&
      plan.timeZone.length <= 80;
    if (validZone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: plan.timeZone }).format();
      } catch {
        validZone = false;
      }
    }
    const parents = new Set(
      command.tasks
        .map((t) => t.parentKey)
        .filter((k): k is string => typeof k === "string"),
    );
    const target = command.tasks.find((t) => t.id === plan.taskId);
    if (
      !validId(plan.taskId) ||
      !validDay ||
      !validZone ||
      !target ||
      parents.has(target.key) ||
      target.dependsOn.length > 0
    )
      fail("AI_INVALID_COMMAND");
  }
}
/** Builds one atomic workspace command; all generated IDs and time are frozen before committing. */
export function buildMobileAiApply(
  snapshot: WorkspaceSnapshot,
  command: AiApplyCommand,
  workspaceId: string,
  occurredAt: string,
  idFactory: () => string = () => crypto.randomUUID(),
  localRecoveryReadSet?: AiRecoveryReadSet,
): { workspace: WorkspaceCommand; receipt: AiApplyReceipt } {
  checkCommand(command);
  if (!Number.isFinite(Date.parse(occurredAt))) fail("AI_INVALID_COMMAND");
  const existing = findApplication(snapshot, command.operationId);
  if (existing) {
    if (canonical(existing.application.command) !== canonical(command))
      fail("AI_OPERATION_CHANGED");
    fail("AI_ALREADY_APPLIED");
  }
  if (
    snapshot.entities.some((e) =>
      applications(e).some((a) => a.runId === command.runId),
    )
  )
    fail("AI_ALREADY_APPLIED");
  const byId = new Map(snapshot.entities.map((e) => [e.id, e]));
  const project = command.project ? byId.get(command.project.id) : null;
  if (command.project) {
    const basis = new Map(command.basisTasks.map((t) => [t.id, t.version]));
    const current = snapshot.entities.filter(
      (e) =>
        !e.deleted &&
        e.kind === "task" &&
        e.data.projectId === command.project!.id,
    );
    if (
      !project ||
      project.deleted ||
      project.kind !== "project" ||
      project.version !== command.project.version ||
      project.data.status !== "active" ||
      project.data.archivedAt ||
      Number(project.data.planVersion ?? 0) !== command.project.planVersion ||
      current.length !== basis.size ||
      current.some((t) => basis.get(t.id) !== t.version)
    )
      fail("AI_STALE_PROJECT");
  }
  if (command.basisRecovery) {
    if (
      !project ||
      !localRecoveryReadSet ||
      localRecoveryReadSet.projectId !== project.id ||
      canonical(aiRecoveryReadSet(snapshot, project.id)) !==
        canonical(localRecoveryReadSet)
    )
      fail("AI_STALE_PROJECT");
    const currentContext = mobileAiContext(snapshot, project);
    const versions = (records: { id: string; version: number }[]) =>
      records
        .map((record) => ({ id: record.id, version: record.version }))
        .sort((a, b) => a.id.localeCompare(b.id));
    if (
      (currentContext.recovery?.version ?? null) !==
        command.basisRecovery.version ||
      canonical(versions(currentContext.recentRecords ?? [])) !==
        canonical(versions(command.basisRecovery.records))
    )
      fail("AI_STALE_PROJECT");
  }
  const source = command.source ? byId.get(command.source.id) : null;
  if (
    command.source &&
    (!source ||
      source.deleted ||
      source.kind !== "capture" ||
      source.version !== command.source.version ||
      source.data.status === "clarified" ||
      source.data.rawText !== command.source.rawText)
  )
    fail("AI_STALE_SOURCE");
  const captureId = source?.id ?? command.operationId;
  const projectId = command.project?.id ?? command.newProject?.id ?? null;
  const newIds = [
    captureId,
    ...command.tasks.map((t) => t.id),
    ...(command.newProject ? [command.newProject.id] : []),
  ];
  if (
    new Set(newIds).size !== newIds.length ||
    command.tasks.some((t) => byId.has(t.id)) ||
    (!source && byId.has(captureId)) ||
    (command.newProject && byId.has(command.newProject.id))
  )
    fail("AI_INVALID_COMMAND");
  const changes: WorkspaceCommand["changes"] = [];
  if (command.newProject)
    changes.push({
      id: command.newProject.id,
      kind: "project",
      expectedVersion: null,
      data: {
        title: command.newProject.name.trim(),
        outcome: command.newProject.outcome.trim(),
        status: "active",
        planVersion: 1,
      },
    });
  else if (project)
    changes.push({
      id: project.id,
      kind: "project",
      expectedVersion: project.version,
      data: {
        ...project.data,
        planVersion: Number(project.data.planVersion ?? 0) + 1,
      },
    });
  const taskByKey = new Map(command.tasks.map((t) => [t.key, t.id]));
  const childRank = new Map<string, number>();
  let rootRank = 0;
  for (const task of command.tasks) {
    const parentId = task.parentKey ? taskByKey.get(task.parentKey)! : null;
    const rank = parentId
      ? (childRank.set(parentId, (childRank.get(parentId) ?? 0) + 1),
        childRank.get(parentId)!)
      : ++rootRank;
    const scheduledToday =
      command.scheduleToday?.taskId === task.id
        ? command.scheduleToday.date
        : undefined;
    changes.push({
      id: task.id,
      kind: "task",
      expectedVersion: null,
      data: {
        title: task.title.trim(),
        completionCriteria: task.criteria.trim(),
        estimatedMinutes: task.estimatedMinutes,
        notes: task.notes ?? "由规划草稿采用，原始意图保留在关联收集项。",
        ...(scheduledToday ? { executionDate: scheduledToday } : {}),
        ...(task.deadline !== undefined
          ? {
              dueDate: task.deadline,
              desktop: {
                deadline_value: task.deadline
                  ? JSON.stringify({ kind: "date", date: task.deadline })
                  : null,
              },
            }
          : {}),
        status: "todo",
        projectId,
        parentId,
        rank,
        priority: 0,
        tags: [],
        sourceCaptureId: captureId,
        dependencies: task.dependsOn.map((key) => taskByKey.get(key)!),
      },
    });
  }
  const dependencyRows: FrozenOutput[] = [];
  for (const task of command.tasks)
    for (const key of task.dependsOn) {
      const id = idFactory();
      if (
        !validId(id) ||
        byId.has(id) ||
        newIds.includes(id) ||
        dependencyRows.some((r) => r.id === id)
      )
        fail("AI_INVALID_COMMAND");
      dependencyRows.push({ id, version: 1 });
      changes.push({
        id,
        kind: "desktop_row",
        expectedVersion: null,
        data: {
          table: "task_dependencies",
          row: { task_id: task.id, predecessor_id: taskByKey.get(key)! },
        },
      });
    }
  const outputs = command.tasks.map((t) => ({
    id: t.id,
    kind: "task" as const,
    version: 1,
  }));
  const outputVersions: FrozenOutput[] = command.tasks.map((t) => ({
    id: t.id,
    version: 1,
  }));
  let rewardId: string | null = null;
  if (command.reward) {
    rewardId = idFactory();
    if (
      !validId(rewardId) ||
      byId.has(rewardId) ||
      newIds.includes(rewardId) ||
      dependencyRows.some((r) => r.id === rewardId)
    )
      fail("AI_INVALID_COMMAND");
    changes.push({
      id: rewardId,
      kind: "record",
      expectedVersion: null,
      data: {
        title: "奖励约定：" + command.reward.title.trim(),
        body:
          "奖励：" +
          command.reward.title.trim() +
          "\n约定条件：" +
          command.reward.condition.trim() +
          "\n\n这是一份奖励想法记录，尚未自动解锁或购买。",
        type: "idea",
        projectId,
        sourceCaptureId: captureId,
      },
    });
    outputVersions.push({ id: rewardId, version: 1 });
  }
  const receipt: AiApplyReceipt = {
    operationId: command.operationId,
    taskIds: command.tasks.map((t) => t.id),
    projectId,
    sourceCaptureId: captureId,
    resolutionId: command.operationId,
    appliedAt: occurredAt,
    undone: false,
  };
  const application: MobileAiApplication = {
    runId: command.runId,
    command,
    receipt,
    captureVersion: source ? source.version + 1 : 1,
    outputVersions,
    dependencyRows,
  };
  const priorApplications = source
    ? applications(source).filter(
        (a, index, all) =>
          all.findIndex(
            (b) => b.receipt.operationId === a.receipt.operationId,
          ) === index,
      )
    : [];
  changes.push({
    id: captureId,
    kind: "capture",
    expectedVersion: source?.version ?? null,
    data: {
      ...source?.data,
      rawText: source ? command.source!.rawText : command.input,
      status: "clarified",
      resolutionId: command.operationId,
      outputs: [
        ...outputs,
        ...(rewardId ? [{ id: rewardId, kind: "record", version: 1 }] : []),
      ],
      aiApplication: application,
      aiApplications: [...priorApplications, application],
    },
  });
  return {
    receipt,
    workspace: {
      operationId: command.operationId,
      occurredAt,
      changes,
      expectedWorkspaceId: workspaceId,
      expectedAiRunUnused: command.runId,
      ...(command.basisRecovery
        ? { expectedAiRecoveryReadSet: localRecoveryReadSet! }
        : {}),
      ...(command.project
        ? {
            expectedProjectTasks: {
              projectId: command.project.id,
              projectVersion: command.project.version,
              tasks: command.basisTasks,
            },
          }
        : {}),
    },
  };
}
function references(value: unknown, ids: Set<string>): boolean {
  if (typeof value === "string") return ids.has(value);
  if (Array.isArray(value)) return value.some((v) => references(v, ids));
  return (
    !!value &&
    typeof value === "object" &&
    Object.values(value).some((v) => references(v, ids))
  );
}
export function buildMobileAiUndo(
  snapshot: WorkspaceSnapshot,
  applyOperationId: string,
  operationId: string,
  workspaceId: string,
  occurredAt: string,
): WorkspaceCommand | null {
  if (
    !validId(applyOperationId) ||
    !validId(operationId) ||
    !Number.isFinite(Date.parse(occurredAt))
  )
    fail("AI_INVALID_COMMAND");
  const found = findApplication(snapshot, applyOperationId);
  if (!found) fail("AI_INVALID_COMMAND");
  const { capture, application } = found;
  if (application.receipt.undone) return null;
  if (
    capture.deleted ||
    capture.version !== application.captureVersion ||
    capture.data.status !== "clarified" ||
    (capture.data.aiApplication as MobileAiApplication | undefined)?.receipt
      .operationId !== applyOperationId
  )
    fail("AI_UNDO_CONFLICT");
  const removed = new Set(
    [...application.outputVersions, ...application.dependencyRows].map(
      (o) => o.id,
    ),
  );
  const taskIds = new Set(application.receipt.taskIds);
  const byId = new Map(snapshot.entities.map((e) => [e.id, e]));
  for (const output of application.outputVersions) {
    const entity = byId.get(output.id);
    const allowedExecutionDate =
      application.command.scheduleToday?.taskId === output.id
        ? application.command.scheduleToday.date
        : undefined;
    if (
      !entity ||
      entity.deleted ||
      entity.version !== output.version ||
      (entity.kind === "task" &&
        (entity.data.status !== "todo" ||
          (entity.data.executionDate &&
            entity.data.executionDate !== allowedExecutionDate) ||
          entity.data.startDate ||
          entity.data.dueDate ||
          entity.data.followUpDate))
    )
      fail("AI_UNDO_CONFLICT");
  }
  for (const edge of application.dependencyRows) {
    const entity = byId.get(edge.id);
    const row = entity?.data.row as Record<string, unknown> | undefined;
    if (
      !entity ||
      entity.deleted ||
      entity.version !== edge.version ||
      entity.kind !== "desktop_row" ||
      entity.data.table !== "task_dependencies" ||
      !row ||
      !taskIds.has(String(row.task_id)) ||
      !taskIds.has(String(row.predecessor_id))
    )
      fail("AI_UNDO_CONFLICT");
  }
  if (
    snapshot.entities.some(
      (e) =>
        !e.deleted &&
        e.id !== capture.id &&
        !removed.has(e.id) &&
        references(e.data, removed),
    )
  )
    fail("AI_UNDO_CONFLICT");
  const updated: MobileAiApplication = {
    ...application,
    receipt: { ...application.receipt, undone: true },
  };
  const history = applications(capture)
    .filter(
      (a, index, all) =>
        all.findIndex(
          (b) => b.receipt.operationId === a.receipt.operationId,
        ) === index,
    )
    .map((a) => (a.receipt.operationId === applyOperationId ? updated : a));
  const changes: WorkspaceCommand["changes"] = [...removed].map((id) => {
    const entity = byId.get(id)!;
    return {
      id,
      kind: entity.kind,
      expectedVersion: entity.version,
      data:
        entity.kind === "task"
          ? { ...entity.data, status: "cancelled" }
          : entity.data,
      deleted: true,
    };
  });
  changes.push({
    id: capture.id,
    kind: "capture",
    expectedVersion: capture.version,
    data: {
      ...capture.data,
      status: "inbox",
      outputs: [],
      lastOutputs: capture.data.outputs ?? [],
      aiApplication: updated,
      aiApplications: history,
    },
  });
  return { operationId, occurredAt, changes, expectedWorkspaceId: workspaceId };
}
export function createMobileAiAdapter(port: AiMobilePort) {
  const keyFor = (scope: string, operationId: string) =>
    "praxis-ai-write-v1:" + encodeURIComponent(scope) + ":" + operationId;
  const bindOperation = (operationId: string, scope: string) => {
    if (!validId(operationId)) fail("AI_INVALID_COMMAND");
    const key = "praxis-ai-operation-scope-v1:" + operationId;
    try {
      const previous = port.cache.getItem(key);
      if (previous && previous !== scope) fail("AI_STALE_PROJECT");
      if (!previous) port.cache.setItem(key, scope);
    } catch (e) {
      if (e instanceof Error && e.message === "AI_STALE_PROJECT") throw e;
      fail("AI_APPLY_UNCONFIRMED");
    }
  };
  const read = (key: string): MobileAiWrite | null => {
    try {
      const raw = port.cache.getItem(key);
      if (!raw) return null;
      const value = JSON.parse(raw) as MobileAiWrite;
      if (
        !value ||
        !["apply", "undo"].includes(value.kind) ||
        !value.workspace?.changes?.length
      )
        fail("AI_OPERATION_CHANGED");
      return value;
    } catch (e) {
      throw e instanceof Error && e.message === "AI_OPERATION_CHANGED"
        ? e
        : Error("AI_APPLY_UNCONFIRMED");
    }
  };
  const save = (key: string, value: MobileAiWrite) => {
    try {
      port.cache.setItem(key, JSON.stringify(value));
    } catch {
      fail("AI_APPLY_UNCONFIRMED");
    }
  };
  const forget = (key: string) => {
    try {
      port.cache.removeItem(key);
    } catch {
      /* The durable receipt is authoritative. */
    }
  };
  const execute = async (write: MobileAiWrite, key: string, scope: string) => {
    if ((await port.scope()).key !== scope) fail("AI_STALE_PROJECT");
    try {
      await port.commit(write.workspace);
    } catch (e) {
      if (e instanceof WorkspaceRejectedError) {
        forget(key);
        if (e.message.startsWith("AI_")) throw e;
        if (write.kind === "undo") fail("AI_UNDO_CONFLICT");
        fail(write.command?.source ? "AI_STALE_SOURCE" : "AI_INVALID_COMMAND");
      }
      fail("AI_APPLY_UNCONFIRMED");
    }
  };
  return {
    async receipt(operationId: string) {
      const scope = await port.scope();
      bindOperation(operationId, scope.key);
      const receipt = mobileAiReceipt(await port.snapshot(), operationId);
      if (receipt) forget(keyFor(scope.key, operationId));
      return receipt;
    },
    async apply(
      command: AiApplyCommand,
      localRecoveryReadSet?: AiRecoveryReadSet,
    ) {
      const scope = await port.scope();
      bindOperation(command.operationId, scope.key);
      const snapshot = await port.snapshot();
      const found = findApplication(snapshot, command.operationId);
      if (found) {
        if (canonical(found.application.command) !== canonical(command))
          fail("AI_OPERATION_CHANGED");
        forget(keyFor(scope.key, command.operationId));
        return found.application.receipt;
      }
      const key = keyFor(scope.key, command.operationId);
      let write = read(key);
      if (
        write &&
        (write.kind !== "apply" ||
          canonical(write.command) !== canonical(command))
      )
        fail("AI_OPERATION_CHANGED");
      if (!write) {
        const built = buildMobileAiApply(
          snapshot,
          command,
          scope.workspaceId,
          new Date().toISOString(),
          undefined,
          localRecoveryReadSet,
        );
        write = {
          kind: "apply",
          command,
          applyOperationId: command.operationId,
          workspace: built.workspace,
        };
        save(key, write);
      }
      if (command.basisRecovery && !write.workspace.expectedAiRecoveryReadSet)
        fail("AI_STALE_PROJECT");
      await execute(write, key, scope.key);
      const receipt = mobileAiReceipt(
        await port.snapshot(),
        command.operationId,
      );
      if (!receipt) fail("AI_APPLY_UNCONFIRMED");
      forget(key);
      return receipt;
    },
    async undoSavedApplication(applyOperationId: string): Promise<void> {
      const scope = await port.scope();
      bindOperation(applyOperationId, scope.key);
      const key =
        "praxis-ai-inbox-undo-v1:" +
        encodeURIComponent(scope.key) +
        ":" +
        applyOperationId;
      let operationId: string;
      try {
        operationId = port.cache.getItem(key) ?? crypto.randomUUID();
        if (!validId(operationId)) fail("AI_OPERATION_CHANGED");
        port.cache.setItem(key, operationId);
      } catch (e) {
        if (e instanceof Error && e.message === "AI_OPERATION_CHANGED") throw e;
        fail("AI_APPLY_UNCONFIRMED");
      }
      await this.undo(operationId, applyOperationId);
    },
    async undo(operationId: string, applyOperationId: string) {
      const scope = await port.scope();
      bindOperation(operationId, scope.key);
      bindOperation(applyOperationId, scope.key);
      const snapshot = await port.snapshot();
      const current = mobileAiReceipt(snapshot, applyOperationId);
      if (!current) fail("AI_INVALID_COMMAND");
      if (current.undone) return;
      const key = keyFor(scope.key, operationId);
      let write = read(key);
      if (
        write &&
        (write.kind !== "undo" || write.applyOperationId !== applyOperationId)
      )
        fail("AI_OPERATION_CHANGED");
      if (!write) {
        const workspace = buildMobileAiUndo(
          snapshot,
          applyOperationId,
          operationId,
          scope.workspaceId,
          new Date().toISOString(),
        );
        if (!workspace) return;
        write = { kind: "undo", command: null, applyOperationId, workspace };
        save(key, write);
      }
      await execute(write, key, scope.key);
      if (!mobileAiReceipt(await port.snapshot(), applyOperationId)?.undone)
        fail("AI_APPLY_UNCONFIRMED");
      forget(key);
    },
  };
}
