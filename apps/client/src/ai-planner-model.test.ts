import { describe, expect, it } from "vitest";
import type {
  AiGenerateRequest,
  AiProposal,
  AiRun,
} from "../../api/src/ai-contract";
import {
  buildAiApplyCommand,
  plannerGenerateRequest,
  aiProposalSources,
  contextHasChanged,
  newPlannerDraft,
  plannerStorageKey,
  receiveAiRun,
  restorePlannerDraft,
  selectAiStep,
  type AiPlannerLaunch,
} from "./ai-planner-model";

const launch = (): AiPlannerLaunch => ({
  mode: "decompose",
  input: "准备摄影作品集",
  context: {
    date: "2026-10-25",
    timeZone: "Asia/Hong_Kong",
    project: null,
    tasks: [],
    source: null,
  },
});
const proposal = (): AiProposal => ({
  summary: "先选片，再确定主题。",
  projectName: "摄影作品集",
  outcome: "发布第一组作品",
  assumptions: ["使用已有照片"],
  question: null,
  nextAction: "挑选十张照片",
  tasks: [
    {
      key: "s1",
      title: "挑选十张照片",
      criteria: "十张照片放进同一文件夹",
      estimatedMinutes: 15,
      dependsOn: [],
    },
    {
      key: "s2",
      title: "整理作品主题",
      criteria: "写出主题并关联照片",
      estimatedMinutes: 30,
      dependsOn: ["s1"],
    },
    {
      key: "s3",
      title: "检查发布渠道",
      criteria: "确定一个可用的发布入口",
      estimatedMinutes: null,
      dependsOn: [],
    },
  ],
  reward: { title: "一次摄影出游", condition: "发布第一组作品" },
  suggestedTaskId: null,
});
function ready() {
  const initial = newPlannerDraft(launch());
  const request: AiGenerateRequest = {
    id: crypto.randomUUID(),
    mode: "decompose",
    input: initial.input,
    constraints: "",
    context: initial.launch.context,
  };
  const run: AiRun = {
    id: request.id,
    mode: "decompose",
    status: "ready",
    proposal: proposal(),
    error: null,
    createdAt: "2026-10-25T10:00:00Z",
    updatedAt: "2026-10-25T10:00:01Z",
    sourceDigest: "source-digest",
    model: "test-model",
  };
  return receiveAiRun({ ...initial, request }, run);
}
describe("AI planner adoption", () => {
  it("includes prerequisites and removes downstream selections when a prerequisite is deselected", () => {
    const initial = ready().tasks.map((t) => ({ ...t, selected: false }));
    const chosen = selectAiStep(initial, "s2", true);
    expect(chosen.filter((t) => t.selected).map((t) => t.key)).toEqual([
      "s1",
      "s2",
    ]);
    const independent = selectAiStep(chosen, "s3", true);
    const removed = selectAiStep(independent, "s1", false);
    expect(removed.filter((t) => t.selected).map((t) => t.key)).toEqual(["s3"]);
  });
  it("carries edited fields and original entity versions while preserving a pending operation exactly", () => {
    const draft = ready();
    const project = {
      id: crypto.randomUUID(),
      name: "作品集",
      outcome: "发布作品",
      version: 3,
      planVersion: 7,
    };
    const task = {
      id: crypto.randomUUID(),
      title: "已存在步骤",
      status: "completed",
      version: 4,
      dependencies: [],
      estimatedMinutes: 15,
    };
    draft.request!.context = {
      ...draft.request!.context,
      project,
      tasks: [task],
    };
    draft.tasks[0]!.title = "选择十二张照片";
    draft.tasks[0]!.criteria = "十二张照片已选出";
    const command = buildAiApplyCommand(draft);
    expect(command.project).toEqual({
      id: project.id,
      version: 3,
      planVersion: 7,
    });
    expect(command.newProject).toBeNull();
    expect(command.basisTasks).toEqual([{ id: task.id, version: 4 }]);
    expect(command.tasks[0]).toMatchObject({
      id: draft.tasks[0]!.id,
      title: "选择十二张照片",
      criteria: "十二张照片已选出",
    });
    expect(command.tasks[0]).not.toHaveProperty("selected");
    const pending = { ...draft, pendingApply: command };
    pending.input = "一次尚未确认的保存不能改意图";
    expect(buildAiApplyCommand(pending)).toBe(command);
  });
  it("rejects incomplete selection, changed intent, missing criteria, and dependencies without a project", () => {
    const draft = ready();
    draft.tasks[0]!.selected = false;
    expect(() => buildAiApplyCommand(draft)).toThrow("缺少前置");
    draft.tasks[0]!.selected = true;
    draft.input = "新的目标";
    expect(() => buildAiApplyCommand(draft)).toThrow("输入已修改");
    draft.input = draft.request!.input;
    draft.tasks[0]!.criteria = "";
    expect(() => buildAiApplyCommand(draft)).toThrow("完成标准");
    draft.tasks[0]!.criteria = "已选照片";
    draft.createProject = false;
    expect(() => buildAiApplyCommand(draft)).toThrow("需要归属项目");
  });
  it("rejects a parent-summary suggestion and retains the full basis task set", () => {
    const draft = ready();
    const project = {
      id: crypto.randomUUID(),
      name: "作品集",
      outcome: "发布作品",
      version: 1,
      planVersion: 1,
    };
    const parentId = crypto.randomUUID();
    const childId = crypto.randomUUID();
    draft.request!.context = {
      ...draft.request!.context,
      project,
      tasks: [
        {
          id: parentId,
          title: "作品集汇总",
          status: "todo",
          version: 2,
          dependencies: [],
          estimatedMinutes: null,
          parentId: null,
        },
        {
          id: childId,
          title: "挑选照片",
          status: "todo",
          version: 3,
          dependencies: [],
          estimatedMinutes: 15,
          parentId,
        },
      ],
    };
    const invalidRun = {
      ...draft.run!,
      updatedAt: "2026-10-25T11:00:00Z",
      proposal: { ...proposal(), suggestedTaskId: parentId },
    };
    expect(() => receiveAiRun(draft, invalidRun)).toThrow(
      "AI_UNREADY_SUGGESTION",
    );
    const validRun = {
      ...invalidRun,
      proposal: { ...proposal(), suggestedTaskId: childId },
    };
    expect(receiveAiRun(draft, validRun).run!.proposal!.suggestedTaskId).toBe(
      childId,
    );
    expect(buildAiApplyCommand(draft).basisTasks).toEqual([
      { id: parentId, version: 2 },
      { id: childId, version: 3 },
    ]);
  });
  it("keeps task IDs and user edits when the same ready run is queried again", () => {
    const draft = ready();
    draft.tasks[0]!.title = "手动修改过的行动";
    draft.tasks[2]!.selected = false;
    const refreshed = receiveAiRun(
      draft,
      JSON.parse(JSON.stringify(draft.run)) as AiRun,
    );
    expect(refreshed.tasks).toEqual(draft.tasks);
    const malicious = {
      ...draft.run!,
      proposal: { ...proposal(), approved: true },
    };
    expect(() => receiveAiRun(draft, malicious as unknown as AiRun)).toThrow(
      "AI_INVALID_PROPOSAL",
    );
  });
});
describe("AI draft recovery", () => {
  it("isolates account/server scopes and safely ignores malformed local drafts", () => {
    const a = plannerStorageKey("account-a", "https://one.example", launch());
    expect(
      plannerStorageKey("account-b", "https://one.example", launch()),
    ).not.toBe(a);
    expect(
      plannerStorageKey("account-a", "https://two.example", launch()),
    ).not.toBe(a);
    expect(restorePlannerDraft("{broken")).toBeNull();
    expect(
      restorePlannerDraft(
        JSON.stringify({ schema: 1, input: "not a complete draft" }),
      ),
    ).toBeNull();
  });
  it("restores the same pending operation and IDs after restart", () => {
    const draft = ready();
    draft.pendingApply = buildAiApplyCommand(draft);
    const restored = restorePlannerDraft(JSON.stringify(draft));
    expect(restored).not.toBeNull();
    expect(buildAiApplyCommand(restored!)).toEqual(draft.pendingApply);
    expect(restored!.tasks.map((t) => t.id)).toEqual(
      draft.tasks.map((t) => t.id),
    );
  });
  it("detects source, project, task additions and version changes without depending on list order", () => {
    const a = launch().context;
    const taskA = {
      id: "a",
      title: "A",
      status: "todo",
      version: 1,
      dependencies: [],
      estimatedMinutes: null,
    };
    const taskB = {
      id: "b",
      title: "B",
      status: "todo",
      version: 1,
      dependencies: [],
      estimatedMinutes: null,
    };
    const before = { ...a, tasks: [taskA, taskB] };
    expect(
      contextHasChanged(before, { ...before, tasks: [taskB, taskA] }),
    ).toBe(false);
    expect(
      contextHasChanged(before, {
        ...before,
        tasks: [taskA, { ...taskB, version: 2 }],
      }),
    ).toBe(true);
    expect(contextHasChanged(before, { ...before, tasks: [taskA] })).toBe(true);
    const source = { id: "source", rawText: "原文", version: 1 };
    expect(
      contextHasChanged(
        { ...a, source },
        { ...a, source: { ...source, version: 2 } },
      ),
    ).toBe(true);
  });
});

describe("project recovery evidence and explicit time budget", () => {
  const recovery = () => ({
    version: 6,
    updatedAt: "2026-10-25T10:00:00Z",
    definitionOfDone: "发布作品",
    blockerText: "等待照片授权",
    lastContext: "已选十张照片",
    restartHint: "先确认授权",
    waitingNote: "等作者回复",
    reviewDate: null,
    nextActionTaskId: null,
    nextActionCleared: false,
  });
  const project = () => ({
    id: crypto.randomUUID(),
    name: "作品集",
    outcome: "公开发布",
    version: 1,
    planVersion: 0,
  });
  it("freezes recovery absence and empty record collections for new project requests, while keeping old pending bytes unchanged", () => {
    const draft = ready();
    draft.request!.context.project = project();
    draft.createProject = false;
    draft.request!.context.recovery = null;
    draft.request!.context.recentRecords = [];
    expect(buildAiApplyCommand(draft).basisRecovery).toEqual({
      version: null,
      records: [],
    });
    const older = ready();
    const frozen = buildAiApplyCommand(older);
    expect(frozen).not.toHaveProperty("basisRecovery");
    const serialized = JSON.stringify(frozen);
    const restored = restorePlannerDraft(
      JSON.stringify({ ...older, pendingApply: frozen }),
    )!;
    restored.availableMinutes = 30;
    expect(JSON.stringify(buildAiApplyCommand(restored))).toBe(serialized);
  });
  it("detects creation, modification, deletion and membership changes in the actual evidence", () => {
    const saved = launch().context;
    saved.project = project();
    saved.recovery = null;
    saved.recentRecords = [];
    const current = structuredClone(saved);
    current.recovery = recovery();
    expect(contextHasChanged(saved, current)).toBe(true);
    saved.recovery = recovery();
    expect(contextHasChanged(saved, current)).toBe(false);
    current.recovery.version++;
    expect(contextHasChanged(saved, current)).toBe(true);
    current.recovery = null;
    expect(contextHasChanged(saved, current)).toBe(true);
    current.recovery = recovery();
    const record = {
      id: crypto.randomUUID(),
      version: 2,
      title: "最新进展",
      recordType: "progress",
      bodyExcerpt: "完成选片",
      updatedAt: "2026-10-25T10:00:00Z",
      truncated: false,
    };
    current.recentRecords = [record];
    expect(contextHasChanged(saved, current)).toBe(true);
    saved.recentRecords = [record];
    expect(contextHasChanged(saved, current)).toBe(false);
    current.recentRecords = [{ ...record, version: 3 }];
    expect(contextHasChanged(saved, current)).toBe(true);
    current.recentRecords = [];
    expect(contextHasChanged(saved, current)).toBe(true);
  });
  it("sends only explicit minutes and provider context, and requires regeneration after editing the budget", () => {
    const initial = newPlannerDraft({
      ...launch(),
      localRecoveryReadSet: {
        projectId: crypto.randomUUID(),
        entities: [{ id: crypto.randomUUID(), version: 9 }],
      },
    });
    initial.availableMinutes = 20;
    const request = plannerGenerateRequest(initial, initial.launch);
    expect(request.context.availableMinutes).toBe(20);
    expect(JSON.stringify(request)).not.toContain("localRecoveryReadSet");
    expect(JSON.stringify(request)).not.toContain('"entities"');
    expect(initial.launch.context).not.toHaveProperty("availableMinutes");
    const draft = ready();
    draft.availableMinutes = 15;
    draft.request!.context.availableMinutes = 15;
    expect(buildAiApplyCommand(draft)).toBeTruthy();
    draft.availableMinutes = 16;
    expect(() => buildAiApplyCommand(draft)).toThrow("重新生成");
    expect(() =>
      plannerGenerateRequest(
        { ...initial, availableMinutes: 0 },
        initial.launch,
      ),
    ).toThrow("1–1440");
    expect(() =>
      plannerGenerateRequest(
        { ...initial, availableMinutes: 1441 },
        initial.launch,
      ),
    ).toThrow("1–1440");
    expect(
      plannerGenerateRequest(
        { ...initial, availableMinutes: null },
        initial.launch,
      ).context.availableMinutes,
    ).toBeNull();
  });
  it("retains the exact unresolved request and rejects an oversized UTF8 payload without dropping evidence", () => {
    const draft = ready();
    draft.run = null;
    draft.availableMinutes = 30;
    const before = JSON.stringify(draft.request);
    expect(JSON.stringify(plannerGenerateRequest(draft, draft.launch))).toBe(
      before,
    );
    const huge = newPlannerDraft(launch());
    huge.launch.context.tasks = Array.from({ length: 100 }, () => ({
      id: crypto.randomUUID(),
      title: "界".repeat(250),
      status: "todo",
      version: 1,
      dependencies: [],
      estimatedMinutes: 15,
      completionCriteria: "界".repeat(200),
      statusReason: "界".repeat(300),
    }));
    const source = JSON.stringify(huge.launch.context);
    expect(() => plannerGenerateRequest(huge, huge.launch)).toThrow("120,000");
    expect(JSON.stringify(huge.launch.context)).toBe(source);
  });
  it("resolves model references only to actual matching snapshot content and never creates navigation targets", () => {
    const context = launch().context;
    context.project = project();
    context.recovery = recovery();
    context.tasks = [
      {
        id: crypto.randomUUID(),
        title: "真实任务标题",
        status: "todo",
        version: 3,
        dependencies: [],
        estimatedMinutes: 10,
        completionCriteria: "真实任务标准",
      },
    ];
    context.recentRecords = [
      {
        id: crypto.randomUUID(),
        version: 2,
        title: "真实记录标题",
        recordType: "progress",
        bodyExcerpt: "真实记录摘要",
        updatedAt: "2026-10-25T00:00:00Z",
        truncated: true,
      },
    ];
    const source = aiProposalSources(
      {
        ...proposal(),
        references: [
          { kind: "recovery", id: context.project.id, version: 6 },
          { kind: "record", id: context.recentRecords[0]!.id, version: 2 },
          { kind: "task", id: context.tasks[0]!.id, version: 3 },
        ],
      },
      context,
    );
    expect(source.map((item) => item.title)).toEqual([
      "作品集 · 恢复卡",
      "真实记录标题",
      "真实任务标题",
    ]);
    expect(source[1]).toMatchObject({
      content: "真实记录摘要",
      truncated: true,
    });
    expect(source.every((item) => !("href" in item))).toBe(true);
    expect(
      aiProposalSources(
        {
          ...proposal(),
          references: [{ kind: "record", id: crypto.randomUUID(), version: 2 }],
        },
        context,
      ),
    ).toEqual([]);
    expect(
      aiProposalSources(
        {
          ...proposal(),
          references: [
            { kind: "record", id: context.recentRecords[0]!.id, version: 999 },
          ],
        },
        context,
      ),
    ).toEqual([]);
  });
});
