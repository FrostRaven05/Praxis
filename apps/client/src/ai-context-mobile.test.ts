import { describe, expect, it } from "vitest";
import {
  aiRecoveryReadSet,
  type WorkspaceEntity,
  type WorkspaceSnapshot,
} from "@praxis/storage-mobile";
import { isAiTaskReady } from "../../api/src/ai-contract";
import {
  mobileAiContext,
  mobileAiLaunch,
  projectExclusiveRecords,
} from "./ai-context-mobile";

const projectId = crypto.randomUUID(),
  otherProjectId = crypto.randomUUID(),
  taskId = crypto.randomUUID();
const at = "2026-10-25T10:00:00.000Z";
function entity(
  kind: WorkspaceEntity["kind"],
  data: Record<string, unknown>,
  id = crypto.randomUUID(),
  version = 1,
): WorkspaceEntity {
  return {
    id,
    kind,
    data,
    version,
    deleted: false,
    createdAt: at,
    updatedAt: at,
  };
}
function setup(extra: WorkspaceEntity[] = []) {
  const project = entity(
    "project",
    {
      title: "摄影作品",
      outcome: "公开发布",
      status: "active",
      planVersion: 0,
    },
    projectId,
  );
  const task = entity(
    "task",
    {
      title: "选片",
      projectId,
      status: "todo",
      estimatedMinutes: 20,
      completionCriteria: "选出十张照片",
    },
    taskId,
  );
  const snapshot = {
    entities: [project, task, ...extra],
    pendingOperations: 0,
  } as WorkspaceSnapshot;
  return { project, task, snapshot };
}
describe("mobile project recovery sources", () => {
  it("merges normalized editable recovery fields with canonical desktop context without leaking local read-set metadata", () => {
    const canonical = entity("desktop_row", {
      table: "project_context",
      row: {
        project_id: projectId,
        version: 8,
        definition_of_done: "原完成标准",
        blocker_text: "无时间",
        last_context: "上次选片到第十张",
        restart_hint: "接着选片",
        waiting_note: "等待反馈",
        review_date: "2026-10-30",
        next_action_task_id: taskId,
        next_action_cleared: 0,
      },
    });
    const { project, snapshot } = setup([canonical]);
    project.data.completionCriteria = "新完成标准";
    project.data.blocker = "";
    project.data.recoveryNote = "先打开选片目录";
    const launch = mobileAiLaunch(snapshot, project, "resume", "继续作品集");
    expect(launch.context.recovery).toMatchObject({
      version: 8,
      definitionOfDone: "新完成标准",
      blockerText: "",
      lastContext: "上次选片到第十张",
      restartHint: "先打开选片目录",
      waitingNote: "等待反馈",
      nextActionTaskId: taskId,
    });
    expect(launch.localRecoveryReadSet?.entities).toContainEqual({
      id: canonical.id,
      version: 1,
    });
    expect(JSON.stringify(launch.context)).not.toContain(
      "localRecoveryReadSet",
    );
    expect(JSON.stringify(launch.context)).not.toContain(canonical.id);
  });
  it("uses normalized aliases when no desktop recovery row exists and preserves explicit clearing", () => {
    const { project, snapshot } = setup();
    project.data = {
      ...project.data,
      completionCriteria: "十张作品",
      blocker: "缺少授权",
      recoveryNote: "先处理授权",
      nextActionId: null,
      nextActionCleared: true,
    };
    const context = mobileAiContext(snapshot, project);
    expect(context.recovery).toMatchObject({
      version: project.version,
      definitionOfDone: "十张作品",
      blockerText: "缺少授权",
      restartHint: "先处理授权",
      nextActionTaskId: null,
      nextActionCleared: true,
    });
    expect(context.recentRecords).toEqual([]);
    expect(
      mobileAiContext(setup().snapshot, setup().project).recovery,
    ).toBeNull();
  });
  it("only sends records exclusively linked to this project, including task links and canonical rows", () => {
    const exclusive = entity("record", {
      title: "项目进展",
      body: "已完成选片",
      links: [{ targetType: "project", targetId: projectId }],
    });
    const taskOnly = entity("record", {
      title: "任务笔记",
      body: "比较构图",
      taskId,
    });
    const shared = entity("record", {
      title: "多项目周回顾",
      body: "FOREIGN_PRIVATE_CONTENT",
      links: [
        { targetType: "project", targetId: projectId },
        { targetType: "project", targetId: otherProjectId },
      ],
    });
    const foreignTask = entity("task", {
      title: "外部任务",
      projectId: otherProjectId,
      status: "todo",
    });
    const mixedTask = entity("record", {
      title: "多项目任务笔记",
      body: "PRIVATE_TASK_CONTENT",
      projectId,
      taskId: foreignTask.id,
    });
    const canonical = entity("record", {
      title: "同步记录",
      body: "这是一条正文",
      type: "progress",
    });
    const edge = entity("desktop_row", {
      table: "record_links",
      row: {
        record_id: canonical.id,
        target_type: "project",
        target_id: projectId,
      },
    });
    const { project, snapshot } = setup([
      exclusive,
      taskOnly,
      shared,
      foreignTask,
      mixedTask,
      canonical,
      edge,
    ]);
    expect(
      new Set(
        projectExclusiveRecords(snapshot, projectId).map((record) => record.id),
      ),
    ).toEqual(new Set([exclusive.id, taskOnly.id, canonical.id]));
    const context = mobileAiContext(snapshot, project);
    expect(
      context.recentRecords?.find((record) => record.id === canonical.id)
        ?.bodyExcerpt,
    ).toBe("这是一条正文");
    expect(JSON.stringify(context)).not.toContain("FOREIGN_PRIVATE_CONTENT");
    expect(JSON.stringify(context)).not.toContain("PRIVATE_TASK_CONTENT");
    // The broader local guard notices a shared record changing without sending its body.
    expect(aiRecoveryReadSet(snapshot, projectId).entities).toContainEqual({
      id: shared.id,
      version: shared.version,
    });
  });
  it("uses only five newest records and marks Unicode excerpts explicitly", () => {
    const records = Array.from({ length: 6 }, (_, index) => ({
      ...entity("record", {
        title: "📷".repeat(121),
        body: "📷".repeat(501),
        projectId,
      }),
      updatedAt: `2026-10-25T10:00:0${index}.000Z`,
    }));
    const { project, task, snapshot } = setup(records);
    task.data.title = "📷".repeat(251);
    task.data.completionCriteria = "📷".repeat(201);
    task.data.waitingReason = "📷".repeat(301);
    project.data.completionCriteria = "📷".repeat(1001);
    const context = mobileAiContext(snapshot, project);
    expect(context.recentRecords).toHaveLength(5);
    expect(context.recentRecords?.[0]?.id).toBe(records[5]!.id);
    expect(context.truncated).toBe(true);
    expect(context.recentRecords?.every((record) => record.truncated)).toBe(
      true,
    );
    expect(context.recentRecords?.[0]?.title.length).toBe(240);
    expect(context.recentRecords?.[0]?.bodyExcerpt.length).toBe(1000);
    expect(context.recovery?.definitionOfDone.length).toBe(2000);
    expect(context.tasks[0]?.completionCriteria?.length).toBe(400);
    expect(context.tasks[0]?.statusReason?.length).toBe(600);
  });
  it("maps true task estimates, waiting state and schedules before readiness filtering", () => {
    const schedule = entity("desktop_row", {
      table: "project_schedules",
      row: {
        task_id: taskId,
        start_date: "2026-11-01",
        end_date: "2026-11-02",
      },
    });
    const plan = entity("desktop_row", {
      table: "daily_plan_items",
      row: {
        task_id: taskId,
        execution_date: "2026-10-28",
        removed: 0,
        is_summary: 0,
        created_at: at,
      },
    });
    const { project, task, snapshot } = setup([schedule, plan]);
    const context = {
      ...mobileAiContext(snapshot, project),
      date: "2026-10-25",
      availableMinutes: 15,
    };
    expect(context.tasks[0]).toMatchObject({
      estimatedMinutes: 20,
      plannedStart: "2026-11-01",
      plannedEnd: "2026-11-02",
      executionDate: "2026-10-28",
    });
    expect(isAiTaskReady(context.tasks[0]!, context)).toBe(false);
    task.data.waiting = true;
    task.data.waitingReason = "等待授权";
    expect(mobileAiContext(snapshot, project).tasks[0]).toMatchObject({
      status: "waiting",
      statusReason: "等待授权",
    });
    expect(aiRecoveryReadSet(snapshot, projectId).entities).toContainEqual({
      id: schedule.id,
      version: 1,
    });
  });
  it("keeps unprojected capture requests scoped to the source and refuses silently dropping tasks", () => {
    const { snapshot, project } = setup();
    const source = { id: crypto.randomUUID(), version: 1, rawText: "灵感" };
    const context = mobileAiContext(snapshot, null, source);
    expect(context).toMatchObject({ project: null, tasks: [], source });
    expect(context).not.toHaveProperty("recentRecords");
    for (let i = 0; i < 100; i++)
      snapshot.entities.push(
        entity("task", { title: "额外任务", status: "todo", projectId }),
      );
    expect(() => mobileAiContext(snapshot, project)).toThrow("最多 100");
  });
});

it("retains project-exclusive records linked to soft-deleted project tasks and guards those historical links", () => {
  const historical = {
    ...entity("task", { title: "已归档行动", projectId, status: "completed" }),
    deleted: true,
  };
  const note = entity("record", {
    title: "历史行动复盘",
    body: "可用于恢复项目的真实记录",
    taskId: historical.id,
  });
  const { project, snapshot } = setup([historical, note]);
  const context = mobileAiContext(snapshot, project);
  expect(context.tasks.some((task) => task.id === historical.id)).toBe(false);
  expect(context.recentRecords?.map((record) => record.id)).toContain(note.id);
  expect(aiRecoveryReadSet(snapshot, projectId).entities).toContainEqual({
    id: note.id,
    version: note.version,
  });
});
it("prefers the latest valid plan estimate and falls back to the default when that newest plan has no estimate", () => {
  const earlier = entity("desktop_row", {
    table: "daily_plan_items",
    row: {
      task_id: taskId,
      execution_date: "2026-10-25",
      estimated_minutes: 45,
      created_at: "2026-10-25T08:00:00Z",
      removed: 0,
      is_summary: 0,
    },
  });
  const latest = entity("desktop_row", {
    table: "daily_plan_items",
    row: {
      task_id: taskId,
      execution_date: "2026-10-26",
      estimated_minutes: 10,
      created_at: "2026-10-25T09:00:00Z",
      removed: 0,
      is_summary: 0,
    },
  });
  const { project, snapshot } = setup([earlier, latest]);
  expect(mobileAiContext(snapshot, project).tasks[0]?.estimatedMinutes).toBe(
    10,
  );
  (latest.data.row as Record<string, unknown>).estimated_minutes = null;
  expect(mobileAiContext(snapshot, project).tasks[0]?.estimatedMinutes).toBe(
    20,
  );
  (latest.data.row as Record<string, unknown>).removed = 1;
  expect(mobileAiContext(snapshot, project).tasks[0]?.estimatedMinutes).toBe(
    45,
  );
});
it("reads canonical context wire versions and task status reasons without sending raw desktop metadata", () => {
  const recovery = entity(
    "desktop_row",
    {
      table: "project_context",
      row: { project_id: projectId, last_context: "真实恢复说明" },
    },
    crypto.randomUUID(),
    4,
  );
  const { project, task, snapshot } = setup([recovery]);
  task.data.desktop = {
    status_reason: "等待授权",
    default_estimated_minutes: 25,
  };
  delete task.data.estimatedMinutes;
  const context = mobileAiContext(snapshot, project);
  expect(context.recovery?.version).toBe(3);
  expect(context.tasks[0]).toMatchObject({
    statusReason: "等待授权",
    estimatedMinutes: 25,
  });
  expect(JSON.stringify(context)).not.toContain('"desktop"');
  task.data.estimatedMinutes = null;
  expect(
    mobileAiContext(snapshot, project).tasks[0]?.estimatedMinutes,
  ).toBeNull();
});

it("renders a complete canonical weekly review excerpt and preserves ordinary record bodies for partial legacy rows", () => {
  const record = entity("record", {
    title: "项目回顾",
    body: "普通正文",
    type: "review",
    projectId,
  });
  const row = entity("desktop_row", {
    table: "weekly_reviews",
    row: {
      record_id: record.id,
      period_start: "2026-10-19",
      period_end: "2026-10-25",
      achievements: "已发布作品",
      blockers: "缺少反馈",
      stop_pause: "停止重排",
      next_focus: "发给朋友",
    },
  });
  const { project, snapshot } = setup([record, row]);
  expect(
    mobileAiContext(snapshot, project).recentRecords?.[0]?.bodyExcerpt,
  ).toContain("已发布作品");
  row.data.row = { record_id: record.id };
  expect(
    mobileAiContext(snapshot, project).recentRecords?.[0]?.bodyExcerpt,
  ).toBe("普通正文");
});
