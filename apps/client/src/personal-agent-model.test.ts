import { expect, it } from "vitest";
import {
  personalTaskQuery,
  type PersonalTaskRead,
  type WorkSnapshot,
  type WorkTask,
} from "@praxis/application";
import {
  addPersonalAgentTask,
  draftAvailableDependencies,
  draftReadyLeafTasks,
  newPersonalAgentDraft,
  personalAgentApply,
  personalAgentBasis,
  personalAgentKey,
  personalAgentSnapshot,
  receivePersonalAgentRun,
  restorePersonalAgentDraft,
  resolvePersonalAgentApply,
  togglePersonalAgentTask,
} from "./personal-agent-model";
import type { AiContextTask, AiRun } from "../../api/src/ai-contract";
const id = () => crypto.randomUUID(),
  projectId = id(),
  now = new Date("2026-11-12T04:00:00Z");
const task = (title: string, patch: Partial<WorkTask> = {}): WorkTask => ({
  id: id(),
  title,
  notes: "旧说明",
  projectId,
  parentId: null,
  sectionId: null,
  status: "todo",
  version: 1,
  plan: null,
  deadline: null,
  followUp: null,
  priority: 4,
  important: 0,
  waitingFor: "",
  waitingNote: "",
  completedAt: null,
  createdAt: now.toISOString(),
  rank: 0,
  labels: [],
  ...patch,
});
function fixture() {
  const rows = [
    task("逾期", { deadline: { kind: "date", date: "2026-11-01" } }),
    task("进行中", { status: "in_progress" }),
    task("之后处理"),
    task("第四项"),
    task("未来安排"),
    task("阻塞", { status: "blocked" }),
    task("已完成", { status: "completed" }),
    task("独立", { projectId: null }),
  ];
  const work: WorkSnapshot = {
    settings: [{ timeZone: "Asia/Hong_Kong", version: 1 }],
    tasks: rows,
    projects: [
      {
        id: projectId,
        name: "个人项目",
        outcome: "目标",
        version: 1,
        planVersion: 1,
        status: "active",
        focused: 0,
        archivedAt: null,
      },
    ],
    sections: [],
    labels: [],
    days: [],
    legacyPlans: [],
    events: [],
    migrationReport: "",
  };
  const base: PersonalTaskRead = {
    scopeKey: "server|owner|workspace",
    work,
    query: personalTaskQuery(work, now),
  };
  const metadata: AiContextTask[] = rows.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    version: t.version,
    parentId: t.parentId,
    dependencies: [],
    estimatedMinutes: null,
    executionDate: t.title === "未来安排" ? "2026-11-20" : null,
  }));
  return { base, metadata, rows };
}
it("computes actual facts and at most three labelled system candidates without mutating tasks", () => {
  const f = fixture(),
    before = structuredClone(f.base.work),
    snapshot = personalAgentSnapshot(f.base, f.metadata, undefined, now);
  expect(snapshot.facts).toMatchObject({
    taskCount: 8,
    completed: 1,
    overdue: 1,
    readAt: now.toISOString(),
  });
  expect(snapshot.suggestions).toHaveLength(3);
  expect(snapshot.suggestions[0]?.title).toBe("逾期");
  expect(snapshot.suggestions[1]?.title).toBe("进行中");
  expect(
    snapshot.suggestions.some((s) =>
      ["未来安排", "阻塞", "已完成"].includes(s.title),
    ),
  ).toBe(false);
  expect(f.base.work).toEqual(before);
});
it("keeps project source narrow and checks versions before constructing its context", () => {
  const f = fixture(),
    meta = f.metadata.filter((t) => t.id !== f.rows.at(-1)!.id);
  const snapshot = personalAgentSnapshot(f.base, meta, projectId, now);
  expect(snapshot.context.tasks).toHaveLength(7);
  expect(snapshot.context.project?.id).toBe(projectId);
  expect(() =>
    personalAgentSnapshot(
      f.base,
      [{ ...meta[0]!, version: 999 }, ...meta.slice(1)],
      projectId,
      now,
    ),
  ).toThrow("已更新");
  f.base.work.projects[0]!.status = "completed";
  expect(personalAgentSnapshot(f.base, meta, projectId, now)).toMatchObject({
    canDecompose: false,
    suggestions: [],
  });
});
it("edits/deletes draft rows and confirms one flat batch with original stable IDs and optional notes/date", () => {
  const f = fixture(),
    snapshot = personalAgentSnapshot(
      f.base,
      f.metadata.filter((t) => t.id !== f.rows.at(-1)!.id),
      projectId,
      now,
    );
  let draft = newPersonalAgentDraft(snapshot, "decompose");
  draft.request = {
    id: id(),
    mode: "decompose",
    input: draft.input,
    constraints: "",
    context: snapshot.context,
  };
  const run: AiRun = {
    id: draft.request.id,
    mode: "decompose",
    status: "ready",
    model: "fixture",
    sourceDigest: "synthetic",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    error: null,
    proposal: {
      summary: "草稿",
      projectName: "",
      outcome: "",
      assumptions: [],
      question: null,
      nextAction: "",
      tasks: [
        {
          key: "s1",
          title: "步骤一",
          criteria: "说明",
          estimatedMinutes: null,
          dependsOn: [],
          notes: "说明",
          deadline: null,
        },
        {
          key: "s2",
          title: "步骤二",
          criteria: "说明",
          estimatedMinutes: null,
          dependsOn: [],
        },
      ],
      reward: null,
      suggestedTaskId: null,
    },
  };
  draft = receivePersonalAgentRun(draft, run);
  const stableId = draft.tasks[0]!.id;
  draft.tasks[1]!.selected = false;
  draft.tasks[0]!.notes = "";
  draft.tasks[0]!.deadline = "2026-12-01";
  const command = personalAgentApply(draft);
  expect(command.tasks).toHaveLength(1);
  expect(command.tasks[0]).toMatchObject({
    id: stableId,
    notes: "",
    deadline: "2026-12-01",
    dependsOn: [],
    estimatedMinutes: null,
  });
  expect(command.reward).toBeNull();
  draft.pending = command;
  draft.tasks[0]!.title = "之后的文本";
  expect(personalAgentApply(draft)).toBe(command);
});
it("cannot turn a read-only next-step response or changed goal into task adoption", () => {
  const f = fixture(),
    snapshot = personalAgentSnapshot(f.base, f.metadata, undefined, now);
  expect(() =>
    personalAgentApply(newPersonalAgentDraft(snapshot, "next")),
  ).toThrow("仅供查看");
  const scoped = personalAgentSnapshot(
      f.base,
      f.metadata.filter((t) => t.id !== f.rows.at(-1)!.id),
      projectId,
      now,
    ),
    d = newPersonalAgentDraft(scoped, "decompose");
  d.request = {
    id: id(),
    mode: "decompose",
    input: d.input,
    constraints: "",
    context: scoped.context,
  };
  d.run = {
    id: d.request.id,
    mode: "decompose",
    status: "ready",
    proposal: null,
    error: null,
    sourceDigest: "",
    model: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
  d.input = "新目标";
  expect(() => personalAgentApply(d)).toThrow("目标已修改");
});
it("isolates caches by account/workspace and refuses another scope's saved draft while preserving its raw data", () => {
  const f = fixture(),
    snapshot = personalAgentSnapshot(f.base, f.metadata, undefined, now),
    draft = newPersonalAgentDraft(snapshot, "next"),
    raw = JSON.stringify(draft);
  expect(restorePersonalAgentDraft(raw, snapshot, "next")).toEqual(draft);
  const other = { ...snapshot, scopeKey: "other|owner|workspace" };
  expect(personalAgentKey(other, "next")).not.toBe(
    personalAgentKey(snapshot, "next"),
  );
  expect(restorePersonalAgentDraft(raw, other, "next")).toBeNull();
  expect(raw).toBe(JSON.stringify(draft));
  expect(personalAgentBasis(snapshot.context)).not.toBe(
    personalAgentBasis({
      ...snapshot.context,
      tasks: snapshot.context.tasks.map((t, i) =>
        i ? t : { ...t, version: t.version + 1 },
      ),
    }),
  );
});
function pendingFixture() {
  const f = fixture(),
    snapshot = personalAgentSnapshot(
      f.base,
      f.metadata.filter((t) => t.id !== f.rows.at(-1)!.id),
      projectId,
      now,
    );
  let draft = newPersonalAgentDraft(snapshot, "decompose");
  draft.request = {
    id: id(),
    mode: "decompose",
    input: draft.input,
    constraints: "",
    context: snapshot.context,
  };
  draft = receivePersonalAgentRun(draft, {
    id: draft.request.id,
    mode: "decompose",
    status: "ready",
    model: "fixture",
    sourceDigest: "synthetic",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    error: null,
    proposal: {
      summary: "草稿",
      projectName: "",
      outcome: "",
      assumptions: [],
      question: null,
      nextAction: "",
      tasks: [
        {
          key: "s1",
          title: "行动",
          criteria: "说明",
          estimatedMinutes: null,
          dependsOn: [],
        },
      ],
      reward: null,
      suggestedTaskId: null,
    },
  });
  draft.pending = personalAgentApply(draft);
  const receipt = {
    operationId: draft.pending.operationId,
    projectId,
    taskIds: draft.pending.tasks.map((t) => t.id),
    sourceCaptureId: id(),
    resolutionId: id(),
    appliedAt: now.toISOString(),
    undone: false,
  };
  return { f, snapshot, draft, receipt };
}
it("marks a 101-task project readonly before generation and preserves an earlier pending receipt for reconciliation", () => {
  const old = pendingFixture(),
    f = fixture();
  f.base.work.tasks = Array.from({ length: 101 }, (_, i) => task("任务" + i));
  f.base.query = personalTaskQuery(f.base.work, now);
  const meta = f.base.work.tasks.map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    version: t.version,
    parentId: null,
    dependencies: [],
    estimatedMinutes: null,
  }));
  const large = personalAgentSnapshot(f.base, meta, projectId, now);
  expect(large).toMatchObject({
    canDecompose: false,
    facts: { taskCount: 101, truncated: true },
  });
  expect(large.context.tasks).toHaveLength(100);
  const next = {
    ...old.draft,
    pending: null,
    request: { ...old.draft.request!, context: large.context },
  };
  expect(() => personalAgentApply(next)).toThrow("安全读取与采用边界");
  expect(
    restorePersonalAgentDraft(JSON.stringify(old.draft), large, "decompose")
      ?.pending?.operationId,
  ).toBe(old.draft.pending!.operationId);
});
it("rejects a restored pending command aimed at another project or task body without replacing the raw draft", () => {
  const { snapshot, draft } = pendingFixture();
  expect(
    restorePersonalAgentDraft(JSON.stringify(draft), snapshot, "decompose"),
  ).not.toBeNull();
  const tampered = structuredClone(draft);
  tampered.pending!.project!.id = id();
  const raw = JSON.stringify(tampered);
  expect(restorePersonalAgentDraft(raw, snapshot, "decompose")).toBeNull();
  expect(raw).toBe(JSON.stringify(tampered));
  const changed = structuredClone(draft);
  changed.pending!.tasks[0]!.title = "未确认的其他内容";
  expect(
    restorePersonalAgentDraft(JSON.stringify(changed), snapshot, "decompose"),
  ).toBeNull();
});
it("rechecks scope after receipt lookup and after commit, retaining the original attempt instead of writing or accepting another account's result", async () => {
  const { draft, receipt } = pendingFixture(),
    pending = draft.pending;
  let scope = draft.scopeKey,
    applies = 0;
  await expect(
    resolvePersonalAgentApply(draft, {
      scope: async () => scope,
      receipt: async () => {
        scope = "another";
        return null;
      },
      apply: async () => {
        applies++;
        return receipt;
      },
    }),
  ).rejects.toThrow("作用域");
  expect(applies).toBe(0);
  expect(draft.pending).toBe(pending);
  scope = draft.scopeKey;
  await expect(
    resolvePersonalAgentApply(draft, {
      scope: async () => scope,
      receipt: async () => null,
      apply: async () => {
        applies++;
        scope = "another";
        return receipt;
      },
    }),
  ).rejects.toThrow("作用域");
  expect(draft.pending).toBe(pending);
  scope = draft.scopeKey;
  expect(
    await resolvePersonalAgentApply(draft, {
      scope: async () => scope,
      receipt: async () => receipt,
      apply: async () => {
        throw Error("must not repeat");
      },
    }),
  ).toEqual(receipt);
  expect(applies).toBe(1);
  await expect(
    resolvePersonalAgentApply(draft, {
      scope: async () => scope,
      receipt: async () => ({ ...receipt, taskIds: [id()] }),
      apply: async () => {
        throw Error("must not write");
      },
    }),
  ).rejects.toThrow("回执与原预览不匹配");
});
it("supports new-project two-level breakdown, dependency editing, subtask toggling, and scheduling the first step to today", () => {
  const f = fixture();
  const snapshot = personalAgentSnapshot(f.base, [], undefined, now, {
    newProject: true,
  });
  expect(snapshot.canDecompose).toBe(true);
  expect(snapshot.context.personal?.scope).toBe("new_project");
  expect(personalAgentKey(snapshot, "decompose")).toContain(":new_project:decompose");
  let draft = newPersonalAgentDraft(snapshot, "decompose", "上线作品集网站");
  expect(draft.newProjectId).toBeTruthy();
  expect(draft.addFirstStepToToday).toBe(true);
  draft.request = {
    id: id(),
    mode: "decompose",
    input: draft.input,
    constraints: "",
    context: snapshot.context,
  };
  draft = receivePersonalAgentRun(draft, {
    id: draft.request.id,
    mode: "decompose",
    status: "ready",
    model: "fixture",
    sourceDigest: "synthetic",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    error: null,
    proposal: {
      summary: "分两阶段推进",
      projectName: "个人作品集网站",
      outcome: "上线十个精选案例",
      assumptions: [],
      question: null,
      nextAction: "挑选十个代表项目",
      tasks: [
        {
          key: "s1",
          title: "阶段一：准备案例",
          criteria: "素材就绪",
          estimatedMinutes: null,
          dependsOn: [],
          parentKey: null,
          notes: "第一阶段",
          deadline: null,
        },
        {
          key: "s2",
          title: "挑选十个代表项目",
          criteria: "十个项目清单",
          estimatedMinutes: null,
          dependsOn: [],
          parentKey: "s1",
          notes: "先选最好的",
          deadline: null,
        },
        {
          key: "s3",
          title: "撰写项目说明",
          criteria: "完成文案",
          estimatedMinutes: null,
          dependsOn: ["s2"],
          parentKey: "s1",
          notes: "",
          deadline: null,
        },
        {
          key: "s4",
          title: "阶段二：发布上线",
          criteria: "公开可访问",
          estimatedMinutes: null,
          dependsOn: ["s3"],
          parentKey: null,
          notes: "",
          deadline: "2026-12-20",
        },
      ],
      reward: null,
      suggestedTaskId: null,
    },
  });
  expect(draft.projectName).toBe("个人作品集网站");
  expect(draft.projectOutcome).toBe("上线十个精选案例");
  const ready = draftReadyLeafTasks(draft.tasks);
  expect(ready.map((t) => t.key)).toEqual(["s2"]);
  expect(draft.firstStepTaskId).toBe(ready[0]!.id);
  // Parent s1 cannot be a dependency target, and s2 cannot depend on s3 or s4 (would create a cycle)
  const s2 = draft.tasks.find((t) => t.key === "s2")!;
  expect(draftAvailableDependencies(draft.tasks, s2.id)).toEqual([]);
  // Adding a subtask to s4 automatically clears s4's leaf dependency so invariant holds
  const withSubtask = addPersonalAgentTask(draft.tasks, "s4");
  const s4After = withSubtask.find((t) => t.key === "s4")!;
  expect(s4After.dependsOn).toEqual([]);
  expect(withSubtask.filter((t) => t.parentKey === "s4")).toHaveLength(1);
  // Unchecking phase s1 unchecks its children s2, s3 and strips dangling deps on s4
  const afterToggle = togglePersonalAgentTask(draft.tasks, draft.tasks[0]!.id, false);
  expect(afterToggle.filter((t) => t.selected).map((t) => t.key)).toEqual(["s4"]);
  expect(afterToggle.find((t) => t.key === "s4")!.dependsOn).toEqual([]);
  // Applying emits newProject, two-level parentKey, dependsOn, null estimate, and scheduleToday
  const command = personalAgentApply(draft);
  expect(command.project).toBeNull();
  expect(command.newProject).toEqual({
    id: draft.newProjectId,
    name: "个人作品集网站",
    outcome: "上线十个精选案例",
  });
  expect(command.tasks.map((t) => [t.key, t.parentKey, t.dependsOn])).toEqual([
    ["s1", null, []],
    ["s2", "s1", []],
    ["s3", "s1", ["s2"]],
    ["s4", null, ["s3"]],
  ]);
  expect(command.tasks.every((t) => t.estimatedMinutes === null)).toBe(true);
  expect(command.scheduleToday).toEqual({
    taskId: s2.id,
    date: snapshot.context.date,
    timeZone: snapshot.context.timeZone,
  });
  draft.pending = command;
  expect(
    restorePersonalAgentDraft(JSON.stringify(draft), snapshot, "decompose")
      ?.pending?.scheduleToday?.taskId,
  ).toBe(s2.id);
});
