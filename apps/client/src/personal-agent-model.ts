import {
  calendarDate,
  personalDeadlineGroup,
  personalDeadlineDay,
  type PersonalTaskRead,
  type WorkSnapshot,
} from "@praxis/application";
import {
  isAiTaskReady,
  validateAiProposal,
  uuidPattern,
  type AiApplyCommand,
  type AiApplyReceipt,
  type AiContextTask,
  type AiGenerateRequest,
  type AiRun,
} from "../../api/src/ai-contract";

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
): PersonalAgentSnapshot {
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
      completionCriteria: (t.completionCriteria || t.notes).slice(0, 400),
      statusReason: (t.statusReason ?? "").slice(0, 600),
      plannedStart: meta.plannedStart ?? null,
      plannedEnd: meta.plannedEnd ?? null,
      executionDate: meta.executionDate ?? null,
    };
  });
  const selected = tasks.slice(0, 100),
    readAt = now.toISOString();
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
  selected: boolean;
}
export interface PersonalAgentDraft {
  schema: 1;
  scopeKey: string;
  projectId: string | null;
  mode: PersonalAgentMode;
  input: string;
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
  `praxis-personal-agent-v1:${encodeURIComponent(snapshot.scopeKey)}:${snapshot.projectId ?? "todos"}:${mode}`;
export const newPersonalAgentDraft = (
  snapshot: PersonalAgentSnapshot,
  mode: PersonalAgentMode,
): PersonalAgentDraft => ({
  schema: 1,
  scopeKey: snapshot.scopeKey,
  projectId: snapshot.projectId,
  mode,
  input:
    mode === "decompose"
      ? (snapshot.context.project?.name ?? "")
      : "请根据现有任务解释一个可执行的下一步，不创建或修改任何任务。",
  request: null,
  run: null,
  tasks: [],
  pending: null,
  receipt: null,
});
export function restorePersonalAgentDraft(
  raw: string | null,
  snapshot: PersonalAgentSnapshot,
  mode: PersonalAgentMode,
): PersonalAgentDraft | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as PersonalAgentDraft;
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
          typeof t.selected === "boolean",
      )
    )
      return null;
    if (d.run?.proposal)
      validateAiProposal(
        d.run.proposal,
        d.request?.context ?? snapshot.context,
      );
    if (d.pending) {
      if (
        d.receipt ||
        !new RegExp(uuidPattern).test(d.pending.operationId) ||
        d.request?.id !== d.run?.id ||
        d.request?.context.project?.id !== d.projectId ||
        d.pending.runId !== d.run?.id
      )
        return null;
      const expected = personalAgentApply({ ...d, pending: null });
      if (
        personalCommandContent(expected) !== personalCommandContent(d.pending)
      )
        return null;
    }
    return d;
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
  return {
    ...draft,
    run,
    tasks:
      draft.mode === "next"
        ? []
        : run.proposal.tasks.map((t) => ({
            id: crypto.randomUUID(),
            key: t.key,
            title: t.title,
            notes: t.notes ?? t.criteria,
            deadline: t.deadline ?? null,
            selected: true,
          })),
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
  if (
    draft.mode !== "decompose" ||
    !draft.request?.context.project ||
    draft.run?.status !== "ready"
  )
    throw Error("此建议仅供查看，不能创建任务。");
  if (draft.input.trim() !== draft.request.input)
    throw Error("目标已修改，请重新生成后再确认。");
  if (draft.request.context.truncated)
    throw Error(
      "当前项目超过安全读取与采用边界，请手动管理或拆分项目；不会按过期版本处理。",
    );
  const selected = draft.tasks.filter((t) => t.selected);
  if (!selected.length) throw Error("请至少保留一项任务。");
  const tasks = selected.map((t) => ({
    id: t.id,
    key: t.key,
    title: t.title.trim(),
    criteria: t.notes.trim() || "完成所述行动",
    notes: t.notes,
    deadline: t.deadline,
    estimatedMinutes: null,
    dependsOn: [],
  }));
  validateAiProposal({
    summary: "个人任务草稿",
    projectName: "",
    outcome: "",
    assumptions: [],
    question: null,
    nextAction: "",
    tasks: tasks.map(({ id: _, ...t }) => t),
    reward: null,
    suggestedTaskId: null,
  });
  const project = draft.request.context.project;
  return {
    operationId: crypto.randomUUID(),
    runId: draft.run.id,
    input: draft.request.input,
    source: null,
    project: {
      id: project.id,
      version: project.version,
      planVersion: project.planVersion,
    },
    newProject: null,
    basisTasks: draft.request.context.tasks.map((t) => ({
      id: t.id,
      version: t.version,
    })),
    tasks,
    reward: null,
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
