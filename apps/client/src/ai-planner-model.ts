import type { AiRecoveryReadSet } from "@praxis/storage-mobile";
import {
  validateAiProposal,
  AI_MAX_REQUEST_BYTES,
  type AiApplyCommand,
  type AiApplyReceipt,
  type AiDraftTask,
  type AiGenerateRequest,
  type AiMode,
  type AiRun,
} from "../../api/src/ai-contract";

export interface AiPlannerLaunch {
  mode: AiMode;
  input: string;
  context: AiGenerateRequest["context"];
  /** Android-only transaction read set; never part of the provider request. */
  localRecoveryReadSet?: AiRecoveryReadSet;
}
export interface EditableAiTask extends AiDraftTask {
  id: string;
  selected: boolean;
}
export interface AiPlannerDraft {
  schema: 1;
  launch: AiPlannerLaunch;
  input: string;
  constraints: string;
  availableMinutes?: number | null;
  request: AiGenerateRequest | null;
  run: AiRun | null;
  tasks: EditableAiTask[];
  projectName: string;
  outcome: string;
  createProject: boolean;
  newProjectId: string;
  keepReward: boolean;
  rewardTitle: string;
  rewardCondition: string;
  pendingApply: AiApplyCommand | null;
  receipt: AiApplyReceipt | null;
  undoOperationId: string | null;
}
export function newPlannerDraft(launch: AiPlannerLaunch): AiPlannerDraft {
  return {
    schema: 1,
    launch,
    input: launch.input,
    constraints: "",
    availableMinutes: null,
    request: null,
    run: null,
    tasks: [],
    projectName: launch.context.project?.name ?? "",
    outcome: launch.context.project?.outcome ?? "",
    createProject: !launch.context.project && launch.mode === "decompose",
    newProjectId: crypto.randomUUID(),
    keepReward: false,
    rewardTitle: "",
    rewardCondition: "",
    pendingApply: null,
    receipt: null,
    undoOperationId: null,
  };
}
export function plannerStorageKey(
  ownerId: string,
  baseUrl: string,
  launch: AiPlannerLaunch,
) {
  const object =
    launch.context.project?.id ?? launch.context.source?.id ?? "capture";
  return [
    "praxis-ai-planner-v1",
    encodeURIComponent(baseUrl),
    ownerId,
    launch.mode,
    object,
  ].join(":");
}
export function restorePlannerDraft(raw: string | null): AiPlannerDraft | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const draft = value as AiPlannerDraft;
    if (
      draft.schema !== 1 ||
      !draft.launch?.context ||
      !["clarify", "decompose", "resume"].includes(draft.launch.mode) ||
      typeof draft.input !== "string" ||
      typeof draft.constraints !== "string" ||
      (draft.availableMinutes !== undefined &&
        draft.availableMinutes !== null &&
        (typeof draft.availableMinutes !== "number" ||
          !Number.isFinite(draft.availableMinutes))) ||
      !Array.isArray(draft.tasks) ||
      typeof draft.projectName !== "string" ||
      typeof draft.outcome !== "string" ||
      typeof draft.newProjectId !== "string" ||
      typeof draft.rewardTitle !== "string" ||
      typeof draft.rewardCondition !== "string"
    )
      return null;
    if (draft.run?.proposal)
      validateAiProposal(
        draft.run.proposal,
        draft.request?.context ?? draft.launch.context,
      );
    if (
      !draft.tasks.every(
        (t) =>
          typeof t.id === "string" &&
          typeof t.key === "string" &&
          typeof t.title === "string" &&
          typeof t.criteria === "string" &&
          typeof t.selected === "boolean" &&
          Array.isArray(t.dependsOn),
      )
    )
      return null;
    return draft;
  } catch {
    return null;
  }
}
export function receiveAiRun(
  draft: AiPlannerDraft,
  run: AiRun,
): AiPlannerDraft {
  if (run.proposal)
    validateAiProposal(
      run.proposal,
      draft.request?.context ?? draft.launch.context,
    );
  const unchanged =
    draft.run?.id === run.id &&
    draft.run.updatedAt === run.updatedAt &&
    !!draft.run.proposal;
  if (!run.proposal || unchanged) return { ...draft, run };
  return {
    ...draft,
    run,
    tasks: run.proposal.tasks.map((t) => ({
      ...t,
      dependsOn: [...t.dependsOn],
      id: crypto.randomUUID(),
      selected: true,
    })),
    projectName:
      run.proposal.projectName || draft.launch.context.project?.name || "",
    createProject:
      !draft.launch.context.project &&
      (draft.createProject ||
        run.proposal.tasks.some((t) => t.dependsOn.length > 0)),
    outcome: run.proposal.outcome,
    keepReward: !!run.proposal.reward,
    rewardTitle: run.proposal.reward?.title ?? "",
    rewardCondition: run.proposal.reward?.condition ?? "",
  };
}
/** Selecting a step includes its prerequisites; removing one also removes dependent steps. */
export function selectAiStep(
  tasks: EditableAiTask[],
  key: string,
  selected: boolean,
): EditableAiTask[] {
  const chosen = new Set(tasks.filter((t) => t.selected).map((t) => t.key));
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const visit = (id: string, seen = new Set<string>()) => {
    if (seen.has(id)) return;
    seen.add(id);
    const task = byKey.get(id);
    if (!task) return;
    chosen.add(id);
    task.dependsOn.forEach((d) => visit(d, seen));
  };
  if (selected) visit(key);
  else {
    chosen.delete(key);
    let changed = true;
    while (changed) {
      changed = false;
      for (const task of tasks) {
        if (
          chosen.has(task.key) &&
          task.dependsOn.some((d) => !chosen.has(d))
        ) {
          chosen.delete(task.key);
          changed = true;
        }
      }
    }
  }
  return tasks.map((t) => ({ ...t, selected: chosen.has(t.key) }));
}
export function contextHasChanged(
  saved: AiGenerateRequest["context"],
  current: AiGenerateRequest["context"],
) {
  if (
    saved.project?.id !== current.project?.id ||
    saved.project?.version !== current.project?.version ||
    saved.project?.planVersion !== current.project?.planVersion ||
    saved.source?.id !== current.source?.id ||
    saved.source?.version !== current.source?.version
  )
    return true;
  const versions = (context: AiGenerateRequest["context"]) =>
    context.tasks
      .map((t) => [t.id, t.version] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  if (JSON.stringify(versions(saved)) !== JSON.stringify(versions(current)))
    return true;
  const records = (context: AiGenerateRequest["context"]) =>
    (context.recentRecords ?? [])
      .map((record) => [record.id, record.version] as const)
      .sort(([a], [b]) => a.localeCompare(b));
  return (
    (saved.recovery?.version ?? null) !== (current.recovery?.version ?? null) ||
    JSON.stringify(records(saved)) !== JSON.stringify(records(current))
  );
}
export function buildAiApplyCommand(draft: AiPlannerDraft): AiApplyCommand {
  if (draft.pendingApply) return draft.pendingApply;
  if (!draft.request || draft.run?.status !== "ready" || !draft.run.proposal)
    throw Error("请先生成可采用的步骤。");
  if (
    draft.input !== draft.request.input ||
    draft.constraints !== draft.request.constraints ||
    (draft.availableMinutes ?? null) !==
      (draft.request.context.availableMinutes ?? null)
  )
    throw Error("输入已修改，请先重新生成建议。");
  const selected = draft.tasks.filter((t) => t.selected);
  if (!selected.length) throw Error("请至少选择一个步骤。");
  const keys = new Set(selected.map((t) => t.key));
  if (selected.some((t) => t.dependsOn.some((d) => !keys.has(d))))
    throw Error("所选步骤缺少前置步骤，请一并选择。");
  if (selected.some((t) => !t.title.trim() || !t.criteria.trim()))
    throw Error("请填写所选步骤的标题和完成标准。");
  if (
    selected.some(
      (t) =>
        t.estimatedMinutes !== null &&
        (!Number.isInteger(t.estimatedMinutes) ||
          t.estimatedMinutes < 1 ||
          t.estimatedMinutes > 480),
    )
  )
    throw Error("预估时长请填写 1—480 分钟，或留空。");
  const project = draft.request.context.project;
  if (
    !project &&
    !draft.createProject &&
    selected.some((t) => t.dependsOn.length > 0)
  )
    throw Error("有前置依赖的步骤需要归属项目，请启用创建项目。");
  if (!project && draft.createProject && !draft.projectName.trim())
    throw Error("请填写项目名称，或取消创建项目。");
  if (
    draft.keepReward &&
    (!draft.rewardTitle.trim() || !draft.rewardCondition.trim())
  )
    throw Error("请填写奖励想法与约定条件，或取消保留奖励。");
  return {
    operationId: crypto.randomUUID(),
    runId: draft.run.id,
    input: draft.request.input,
    source: draft.request.context.source,
    project: project
      ? {
          id: project.id,
          version: project.version,
          planVersion: project.planVersion,
        }
      : null,
    newProject:
      !project && draft.createProject
        ? {
            id: draft.newProjectId,
            name: draft.projectName.trim(),
            outcome: draft.outcome.trim(),
          }
        : null,
    basisTasks: draft.request.context.tasks.map((t) => ({
      id: t.id,
      version: t.version,
    })),
    ...(Object.hasOwn(draft.request.context, "recovery") ||
    Object.hasOwn(draft.request.context, "recentRecords")
      ? {
          basisRecovery: {
            version: draft.request.context.recovery?.version ?? null,
            records: (draft.request.context.recentRecords ?? []).map(
              (record) => ({ id: record.id, version: record.version }),
            ),
          },
        }
      : {}),
    tasks: selected.map(({ selected: _, ...t }) => ({
      ...t,
      title: t.title.trim(),
      criteria: t.criteria.trim(),
    })),
    reward: draft.keepReward
      ? {
          title: draft.rewardTitle.trim(),
          condition: draft.rewardCondition.trim(),
        }
      : null,
  };
}

/** Builds the exact provider request; local read sets are deliberately kept outside context. */
export function plannerGenerateRequest(
  draft: AiPlannerDraft,
  launch: AiPlannerLaunch,
  id = crypto.randomUUID(),
): AiGenerateRequest {
  const unresolved =
    draft.request && (!draft.run || draft.run.status === "running");
  const availableMinutes = draft.availableMinutes ?? null;
  if (
    !unresolved &&
    availableMinutes !== null &&
    (!Number.isInteger(availableMinutes) ||
      availableMinutes < 1 ||
      availableMinutes > 1440)
  )
    throw Error("本次可用时间请填写 1–1440 分钟，或留空。");
  const request: AiGenerateRequest = unresolved
    ? draft.request!
    : {
        id,
        mode: launch.mode,
        input: draft.input,
        constraints: draft.constraints,
        context: { ...launch.context, availableMinutes },
      };
  if (
    new TextEncoder().encode(JSON.stringify(request)).byteLength >
    AI_MAX_REQUEST_BYTES
  )
    throw Error(
      "本次项目资料超过 120,000 字节，请缩小项目范围后重新打开。输入与草稿已保留，尚未发送请求。",
    );
  return request;
}
export function aiProposalSources(
  proposal: AiRun["proposal"],
  context: AiGenerateRequest["context"],
) {
  return (proposal?.references ?? []).flatMap<{
    key: string;
    kind: "recovery" | "record" | "task";
    title: string;
    content: string;
    truncated: boolean;
  }>((reference) => {
    if (
      reference.kind === "recovery" &&
      context.project?.id === reference.id &&
      context.recovery?.version === reference.version
    ) {
      const recovery = context.recovery;
      return [
        {
          key: "recovery:" + reference.id,
          kind: reference.kind,
          title: context.project.name + " · 恢复卡",
          content: [
            ["完成标准", recovery.definitionOfDone],
            ["当前阻塞", recovery.blockerText],
            ["上次上下文", recovery.lastContext],
            ["重启提示", recovery.restartHint],
            ["等待说明", recovery.waitingNote],
          ]
            .filter(([, value]) => value)
            .map(([label, value]) => label + "：" + value)
            .join("\n"),
          truncated: !!context.truncated,
        },
      ];
    }
    if (reference.kind === "record") {
      const record = context.recentRecords?.find(
        (record) =>
          record.id === reference.id && record.version === reference.version,
      );
      return record
        ? [
            {
              key: "record:" + record.id,
              kind: reference.kind,
              title: record.title,
              content: record.bodyExcerpt,
              truncated: record.truncated,
            },
          ]
        : [];
    }
    if (reference.kind === "task") {
      const task = context.tasks.find(
        (task) =>
          task.id === reference.id && task.version === reference.version,
      );
      return task
        ? [
            {
              key: "task:" + task.id,
              kind: reference.kind,
              title: task.title,
              content: [
                task.completionCriteria &&
                  "完成标准：" + task.completionCriteria,
                task.statusReason && "状态说明：" + task.statusReason,
              ]
                .filter(Boolean)
                .join("\n"),
              truncated: !!context.truncated,
            },
          ]
        : [];
    }
    return [];
  });
}
