import {
  calendarDate,
  personalDeadlineGroup,
  personalDeadlineDay,
  type PersonalTaskRead,
  type WorkSnapshot,
} from "@praxis/application";
import {
  AI_MAX_TASKS,
  isAiTaskReady,
  validateAiProposal,
  uuidPattern,
  type AiApplyCommand,
  type AiApplyReceipt,
  type AiContextTask,
  type AiGenerateRequest,
  type AiRun,
} from "../../api/src/ai-contract";
import { notePlainText } from "./task-note";

export type PersonalAgentMode = "decompose" | "next";
export interface PersonalAgentSnapshot {
  scopeKey: string;
  projectId: string | null;
  canDecompose: boolean;
  context: AiGenerateRequest["context"];
  facts: {
    readAt: string;
    taskCount: number;
    completed: number;
    overdue: number;
    progress: number | null;
    legacy: boolean;
    truncated: boolean;
  };
  suggestions: { taskId: string; title: string; reason: string }[];
}
/** Metadata must be read from the same local versions as the personal task snapshot. */
export function personalAgentSnapshot(
  base: PersonalTaskRead,
  metadata: AiContextTask[],
  projectId?: string,
  now = new Date(),
  options?: { newProject?: boolean },
): PersonalAgentSnapshot {
  const readAt = now.toISOString();
  if (options?.newProject && !projectId) {
    const context: AiGenerateRequest["context"] = {
      date: calendarDate(now, base.query.timeZone),
      timeZone: base.query.timeZone,
      project: null,
      tasks: [],
      source: null,
      personal: { scope: "new_project", readAt },
      truncated: false,
    };
    return {
      scopeKey: base.scopeKey,
      projectId: null,
      canDecompose: true,
      context,
      facts: {
        readAt,
        taskCount: 0,
        completed: 0,
        overdue: 0,
        progress: null,
        legacy: false,
        truncated: false,
      },
      suggestions: [],
    };
  }
  const project = projectId
    ? base.work.projects.find((p) => p.id === projectId)
    : null;
  const rows = base.query.list(projectId);
  const byId = new Map(metadata.map((t) => [t.id, t]));
  if (
    metadata.length !== rows.length ||
    rows.some((t) => byId.get(t.id)?.version !== t.version)
  )
    throw Error("任务资料已更新，请重新读取后再打开行动助手。");
  const tasks: AiContextTask[] = rows.map((t) => {
    const meta = byId.get(t.id)!;
    return {
      id: t.id,
      title: t.title,
      status: t.status,
      version: t.version,
      parentId: t.parentId,
      dependencies: [...meta.dependencies],
      estimatedMinutes: null,
      completionCriteria: (t.completionCriteria || notePlainText(t.notes)).slice(0, 400),
      statusReason: (t.statusReason ?? "").slice(0, 600),
      plannedStart: meta.plannedStart ?? null,
      plannedEnd: meta.plannedEnd ?? null,
      executionDate: meta.executionDate ?? null,
    };
  });
  const selected = tasks.slice(0, 100);
  const context: AiGenerateRequest["context"] = {
    date: calendarDate(now, base.query.timeZone),
    timeZone: base.query.timeZone,
    project: project
      ? {
          id: project.id,
          name: project.name,
          outcome: project.outcome ?? "",
          version: project.version,
          planVersion: project.planVersion,
        }
      : null,
    tasks: selected,
    source: null,
    personal: { scope: projectId ? "project" : "todos", readAt },
    truncated: tasks.length > 100,
  };
  const active = (id: string) => {
    const task = base.query.task(id);
    if (!task) return false;
    const p = task.projectId
      ? base.work.projects.find((p) => p.id === task.projectId)
      : null;
    return !task.projectId || (!!p && p.status === "active" && !p.archivedAt);
  };
  const ready = selected.filter(
    (t) => isAiTaskReady(t, context) && active(t.id),
  );
  const due = (id: string) =>
    personalDeadlineGroup(
      base.query.task(id)!.deadline,
      now,
      base.query.timeZone,
    ) === "overdue";
  ready.sort(
    (a, b) =>
      Number(due(b.id)) - Number(due(a.id)) ||
      Number(b.status === "in_progress") - Number(a.status === "in_progress") ||
      a.id.localeCompare(b.id),
  );
  context.personal!.candidateTaskIds = ready.slice(0, 3).map((t) => t.id);
  const progress = projectId ? base.query.progress(projectId) : null;
  const effective = rows.filter((t) => t.status !== "cancelled");
  return {
    scopeKey: base.scopeKey,
    projectId: projectId ?? null,
    canDecompose:
      !!project &&
      project.status === "active" &&
      !project.archivedAt &&
      rows.length <= 100,
    context,
    facts: {
      readAt,
      taskCount: progress?.total ?? effective.length,
      completed:
        progress?.done ??
        effective.filter((t) => t.status === "completed").length,
      overdue:
        progress?.overdue ??
        effective.filter((t) => t.status !== "completed" && due(t.id)).length,
      progress: progress?.percentage ?? null,
      legacy: progress?.mode === "legacy-tree",
      truncated: tasks.length > 100,
    },
    suggestions: ready.slice(0, 3).map((t) => ({
      taskId: t.id,
      title: t.title,
      reason: due(t.id)
        ? "已逾期，宜先了结"
        : t.status === "in_progress"
          ? "已经开始，趁热推进"
          : "随时可以开始",
    })),
  };
}
export interface PersonalAgentTask {
  id: string;
  key: string;
  title: string;
  notes: string;
  deadline: string | null;
  parentKey: string | null;
  dependsOn: string[];
  selected: boolean;
}
export interface PersonalAgentDraft {
  schema: 1;
  scopeKey: string;
  projectId: string | null;
  newProjectId: string | null;
  projectName: string;
  projectOutcome: string;
  mode: PersonalAgentMode;
  input: string;
  addFirstStepToToday: boolean;
  firstStepTaskId: string | null;
  request: AiGenerateRequest | null;
  run: AiRun | null;
  tasks: PersonalAgentTask[];
  pending: AiApplyCommand | null;
  receipt: AiApplyReceipt | null;
}
export const personalAgentKey = (
  snapshot: PersonalAgentSnapshot,
  mode: PersonalAgentMode,
) =>
  `praxis-personal-agent-v1:${encodeURIComponent(snapshot.scopeKey)}:${snapshot.projectId ?? (mode === "decompose" ? "new_project" : "todos")}:${mode}`;
export const newPersonalAgentDraft = (
  snapshot: PersonalAgentSnapshot,
  mode: PersonalAgentMode,
  initialInput?: string,
): PersonalAgentDraft => ({
  schema: 1,
  scopeKey: snapshot.scopeKey,
  projectId: snapshot.projectId,
  newProjectId:
    mode === "decompose" && snapshot.projectId === null
      ? crypto.randomUUID()
      : null,
  projectName: snapshot.context.project?.name ?? "",
  projectOutcome: snapshot.context.project?.outcome ?? "",
  mode,
  input:
    initialInput !== undefined
      ? initialInput
      : mode === "decompose"
        ? (snapshot.context.project?.name ?? "")
        : "请根据现有任务解释一个可执行的下一步，不创建或修改任何任务。",
  addFirstStepToToday: mode === "decompose",
  firstStepTaskId: null,
  request: null,
  run: null,
  tasks: [],
  pending: null,
  receipt: null,
});
export function draftParentKeys(
  tasks: readonly PersonalAgentTask[],
  selectedOnly = true,
): Set<string> {
  const parents = new Set<string>();
  for (const task of tasks) {
    if (selectedOnly && !task.selected) continue;
    if (task.parentKey) parents.add(task.parentKey);
  }
  return parents;
}
export function draftReadyLeafTasks(
  tasks: readonly PersonalAgentTask[],
): PersonalAgentTask[] {
  const active = tasks.filter((t) => t.selected);
  const activeKeys = new Set(active.map((t) => t.key));
  const parents = draftParentKeys(active, true);
  return active.filter(
    (t) =>
      !parents.has(t.key) &&
      (t.parentKey === null || activeKeys.has(t.parentKey)) &&
      t.dependsOn.filter((dep) => activeKeys.has(dep) && !parents.has(dep))
        .length === 0,
  );
}
function reachesDependency(
  tasks: readonly PersonalAgentTask[],
  startKey: string,
  targetKey: string,
): boolean {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const seen = new Set<string>();
  const stack = [startKey];
  while (stack.length) {
    const key = stack.pop()!;
    if (key === targetKey) return true;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = byKey.get(key);
    if (!item) continue;
    for (const dep of item.dependsOn) stack.push(dep);
  }
  return false;
}
export function draftAvailableDependencies(
  tasks: readonly PersonalAgentTask[],
  taskId: string,
): PersonalAgentTask[] {
  const target = tasks.find((t) => t.id === taskId);
  if (!target || !target.selected) return [];
  const parents = draftParentKeys(tasks, true);
  if (parents.has(target.key)) return [];
  return tasks.filter(
    (candidate) =>
      candidate.selected &&
      candidate.id !== target.id &&
      !parents.has(candidate.key) &&
      !target.dependsOn.includes(candidate.key) &&
      !reachesDependency(tasks, candidate.key, target.key),
  );
}
export function togglePersonalAgentTask(
  tasks: readonly PersonalAgentTask[],
  taskId: string,
  selected: boolean,
): PersonalAgentTask[] {
  const target = tasks.find((t) => t.id === taskId);
  if (!target) return [...tasks];
  const next = tasks.map((t) => {
    if (t.id === taskId) return { ...t, selected };
    if (!selected && t.parentKey === target.key) return { ...t, selected: false };
    if (selected && target.parentKey && t.key === target.parentKey)
      return { ...t, selected: true };
    return t;
  });
  const parents = draftParentKeys(next, true);
  const selectedKeys = new Set(next.filter((t) => t.selected).map((t) => t.key));
  return next.map((t) => {
    if (parents.has(t.key) && t.dependsOn.length)
      return { ...t, dependsOn: [] };
    const filtered = t.dependsOn.filter(
      (dep) => selectedKeys.has(dep) && !parents.has(dep),
    );
    return filtered.length === t.dependsOn.length
      ? t
      : { ...t, dependsOn: filtered };
  });
}
export function addPersonalAgentTask(
  tasks: readonly PersonalAgentTask[],
  parentKey: string | null,
): PersonalAgentTask[] {
  if (tasks.length >= AI_MAX_TASKS) return [...tasks];
  if (parentKey !== null) {
    const parent = tasks.find((t) => t.key === parentKey);
    if (!parent || parent.parentKey !== null) return [...tasks];
  }
  const used = new Set(tasks.map((t) => t.key));
  let nextKey: string | null = null;
  for (let i = 1; i <= 99; i++) {
    const candidate = `s${i}`;
    if (!used.has(candidate)) {
      nextKey = candidate;
      break;
    }
  }
  if (!nextKey) return [...tasks];
  const created: PersonalAgentTask = {
    id: crypto.randomUUID(),
    key: nextKey,
    title: "",
    notes: "",
    deadline: null,
    parentKey,
    dependsOn: [],
    selected: true,
  };
  const next = tasks.map((t) => {
    if (parentKey && t.key === parentKey)
      return { ...t, selected: true, dependsOn: [] };
    if (parentKey && t.dependsOn.includes(parentKey))
      return { ...t, dependsOn: t.dependsOn.filter((d) => d !== parentKey) };
    return t;
  });
  if (parentKey === null) return [...next, created];
  let insertAt = next.findIndex((t) => t.key === parentKey);
  while (
    insertAt + 1 < next.length &&
    next[insertAt + 1]!.parentKey === parentKey
  )
    insertAt++;
  next.splice(insertAt + 1, 0, created);
  return next;
}
export function restorePersonalAgentDraft(
  raw: string | null,
  snapshot: PersonalAgentSnapshot,
  mode: PersonalAgentMode,
): PersonalAgentDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as Partial<PersonalAgentDraft> & {
      tasks?: Partial<PersonalAgentTask>[];
    };
    if (
      d.schema !== 1 ||
      d.scopeKey !== snapshot.scopeKey ||
      d.projectId !== snapshot.projectId ||
      d.mode !== mode ||
      typeof d.input !== "string" ||
      !Array.isArray(d.tasks) ||
      !d.tasks.every(
        (t) =>
          typeof t.id === "string" &&
          new RegExp(uuidPattern).test(t.id) &&
          typeof t.key === "string" &&
          typeof t.title === "string" &&
          typeof t.notes === "string" &&
          typeof t.selected === "boolean" &&
          (t.parentKey === undefined ||
            t.parentKey === null ||
            typeof t.parentKey === "string") &&
          (t.dependsOn === undefined ||
            (Array.isArray(t.dependsOn) &&
              t.dependsOn.every((dep) => typeof dep === "string"))),
      )
    )
      return null;
    if (
      d.newProjectId !== undefined &&
      d.newProjectId !== null &&
      (typeof d.newProjectId !== "string" ||
        !new RegExp(uuidPattern).test(d.newProjectId))
    )
      return null;
    const normalized: PersonalAgentDraft = {
      schema: 1,
      scopeKey: d.scopeKey,
      projectId: d.projectId,
      newProjectId:
        d.newProjectId ??
        (mode === "decompose" && snapshot.projectId === null
          ? (d.pending?.newProject?.id ?? crypto.randomUUID())
          : null),
      projectName:
        typeof d.projectName === "string"
          ? d.projectName
          : (d.pending?.newProject?.name ??
            snapshot.context.project?.name ??
            ""),
      projectOutcome:
        typeof d.projectOutcome === "string"
          ? d.projectOutcome
          : (d.pending?.newProject?.outcome ??
            snapshot.context.project?.outcome ??
            ""),
      mode,
      input: d.input,
      addFirstStepToToday:
        typeof d.addFirstStepToToday === "boolean"
          ? d.addFirstStepToToday
          : Boolean(d.pending?.scheduleToday),
      firstStepTaskId:
        typeof d.firstStepTaskId === "string"
          ? d.firstStepTaskId
          : (d.pending?.scheduleToday?.taskId ?? null),
      request: d.request ?? null,
      run: d.run ?? null,
      tasks: d.tasks.map((t) => ({
        id: t.id!,
        key: t.key!,
        title: t.title!,
        notes: t.notes!,
        deadline: t.deadline ?? null,
        parentKey: t.parentKey ?? null,
        dependsOn: Array.isArray(t.dependsOn) ? [...t.dependsOn] : [],
        selected: t.selected!,
      })),
      pending: d.pending ?? null,
      receipt: d.receipt ?? null,
    };
    if (normalized.run?.proposal)
      validateAiProposal(
        normalized.run.proposal,
        normalized.request?.context ?? snapshot.context,
      );
    if (normalized.pending) {
      const targetProjectId =
        normalized.projectId ?? normalized.newProjectId;
      if (
        normalized.receipt ||
        !new RegExp(uuidPattern).test(normalized.pending.operationId) ||
        normalized.request?.id !== normalized.run?.id ||
        (normalized.pending.project?.id ??
          normalized.pending.newProject?.id ??
          null) !== targetProjectId ||
        normalized.pending.runId !== normalized.run?.id
      )
        return null;
      const expected = personalAgentApply({ ...normalized, pending: null });
      if (
        personalCommandContent(expected) !==
        personalCommandContent(normalized.pending)
      )
        return null;
    }
    return normalized;
  } catch {
    return null;
  }
}
export function receivePersonalAgentRun(
  draft: PersonalAgentDraft,
  run: AiRun,
): PersonalAgentDraft {
  if (run.proposal) validateAiProposal(run.proposal, draft.request?.context);
  if (
    !run.proposal ||
    (draft.run?.id === run.id && draft.run.updatedAt === run.updatedAt)
  )
    return { ...draft, run };
  const tasks: PersonalAgentTask[] =
    draft.mode === "next"
      ? []
      : run.proposal.tasks.map((t) => ({
          id: crypto.randomUUID(),
          key: t.key,
          title: t.title,
          notes: t.notes ?? t.criteria,
          deadline: t.deadline ?? null,
          parentKey: t.parentKey ?? null,
          dependsOn: [...t.dependsOn],
          selected: true,
        }));
  const ready = draftReadyLeafTasks(tasks);
  return {
    ...draft,
    run,
    projectName:
      draft.projectId === null && run.proposal.projectName.trim()
        ? run.proposal.projectName.trim()
        : draft.projectName,
    projectOutcome:
      draft.projectId === null && run.proposal.outcome.trim()
        ? run.proposal.outcome.trim()
        : draft.projectOutcome,
    tasks,
    firstStepTaskId: ready[0]?.id ?? null,
  };
}
export function personalAgentBasis(context: AiGenerateRequest["context"]) {
  return JSON.stringify([
    context.project,
    context.date,
    context.timeZone,
    context.tasks
      .map((t) => [t.id, t.version])
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  ]);
}
export function personalAgentApply(draft: PersonalAgentDraft): AiApplyCommand {
  if (draft.pending) return draft.pending;
  const creatingProject = draft.projectId === null;
  if (
    draft.mode !== "decompose" ||
    !draft.request ||
    (!creatingProject && !draft.request.context.project) ||
    draft.run?.status !== "ready"
  )
    throw Error("此建议仅供查看，不能创建任务。");
  if (draft.input.trim() !== draft.request.input)
    throw Error("目标已修改，请重新生成后再确认。");
  if (draft.request.context.truncated)
    throw Error(
      "当前项目超过安全读取与采用边界，请手动管理或拆分项目；不会按过期版本处理。",
    );
  if (creatingProject && (!draft.newProjectId || !draft.projectName.trim()))
    throw Error("请先填写项目名称。");
  const selectedRaw = draft.tasks.filter((t) => t.selected);
  const selectedKeySet = new Set(selectedRaw.map((t) => t.key));
  const selected = selectedRaw.filter(
    (t) => t.parentKey === null || selectedKeySet.has(t.parentKey),
  );
  if (!selected.length) throw Error("请至少保留一项任务。");
  const finalKeys = new Set(selected.map((t) => t.key));
  const parentKeys = draftParentKeys(selected, true);
  const tasks = selected.map((t) => {
    const isParent = parentKeys.has(t.key);
    const deps = isParent
      ? []
      : t.dependsOn.filter((dep) => finalKeys.has(dep) && !parentKeys.has(dep));
    return {
      id: t.id,
      key: t.key,
      title: t.title.trim(),
      criteria: t.notes.trim() || "完成所述行动",
      notes: t.notes,
      deadline: t.deadline,
      parentKey: t.parentKey,
      estimatedMinutes: null,
      dependsOn: deps,
    };
  });
  validateAiProposal({
    summary: "个人任务草稿",
    projectName: creatingProject ? draft.projectName.trim() : "",
    outcome: creatingProject ? draft.projectOutcome.trim() : "",
    assumptions: [],
    question: null,
    nextAction: "",
    tasks: tasks.map(({ id: _, ...t }) => t),
    reward: null,
    suggestedTaskId: null,
  });
  const readyLeaves = tasks.filter(
    (t) => !parentKeys.has(t.key) && t.dependsOn.length === 0,
  );
  const scheduled = draft.addFirstStepToToday
    ? (readyLeaves.find((t) => t.id === draft.firstStepTaskId) ??
      readyLeaves[0] ??
      null)
    : null;
  const project = draft.request.context.project;
  return {
    operationId: crypto.randomUUID(),
    runId: draft.run.id,
    input: draft.request.input,
    source: null,
    project: creatingProject
      ? null
      : {
          id: project!.id,
          version: project!.version,
          planVersion: project!.planVersion,
        },
    newProject: creatingProject
      ? {
          id: draft.newProjectId!,
          name: draft.projectName.trim(),
          outcome: draft.projectOutcome.trim(),
        }
      : null,
    basisTasks: creatingProject
      ? []
      : draft.request.context.tasks.map((t) => ({
          id: t.id,
          version: t.version,
        })),
    tasks,
    reward: null,
    ...(scheduled
      ? {
          scheduleToday: {
            taskId: scheduled.id,
            date: draft.request.context.date,
            timeZone: draft.request.context.timeZone,
          },
        }
      : {}),
  };
}
const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => a.localeCompare(b)),
        )
      : item,
  );
function personalCommandContent(command: AiApplyCommand) {
  const { operationId: _, ...content } = command;
  return canonical(content);
}
/** Receipt lookup and commit may each yield across an account switch. Never accept another scope's absence/result. */
export async function resolvePersonalAgentApply(
  draft: PersonalAgentDraft,
  port: {
    scope(): Promise<string>;
    receipt(operationId: string): Promise<AiApplyReceipt | null>;
    apply(command: AiApplyCommand): Promise<AiApplyReceipt>;
  },
): Promise<AiApplyReceipt> {
  if (!draft.pending) throw Error("尚未保存本次确认命令。");
  const command = JSON.parse(JSON.stringify(draft.pending)) as AiApplyCommand;
  if (
    personalCommandContent(personalAgentApply({ ...draft, pending: null })) !==
    personalCommandContent(command)
  )
    throw Error("原采用命令与预览不匹配，记录已保留但不执行写入。");
  const check = async () => {
    if ((await port.scope()) !== draft.scopeKey)
      throw Error("账号或工作空间已变化，原采用标识保留；请返回原作用域核对。");
  };
  const checkedReceipt = (receipt: AiApplyReceipt) => {
    if (
      receipt.operationId !== command.operationId ||
      receipt.projectId !==
        (command.project?.id ?? command.newProject?.id ?? null) ||
      canonical(receipt.taskIds) !== canonical(command.tasks.map((t) => t.id))
    )
      throw Error("采用回执与原预览不匹配，记录保留但不会继续写入。");
    return receipt;
  };
  await check();
  const receipt = await port.receipt(command.operationId);
  await check();
  if (receipt) return checkedReceipt(receipt);
  await check();
  const applied = await port.apply(command);
  await check();
  return checkedReceipt(applied);
}
/** Context helper for independent tasks; project metadata is supplied by the trusted storage adapter. */
export function independentAgentMetadata(work: WorkSnapshot): AiContextTask[] {
  return work.tasks
    .filter((t) => t.projectId === null)
    .map((t) => ({
      id: t.id,
      title: t.title,
      status: t.status,
      version: t.version,
      parentId: t.parentId,
      dependencies: [],
      estimatedMinutes: null,
      executionDate:
        [
          ...work.legacyPlans
            .filter((p) => p.taskId === t.id)
            .map((p) => p.date),
          personalDeadlineDay(t.plan),
        ]
          .filter((d): d is string => !!d)
          .sort()
          .at(-1) ?? null,
    }));
}
