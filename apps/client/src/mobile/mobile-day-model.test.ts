import { describe, expect, test } from "vitest";
import { mobilePersonalWork } from "@praxis/storage-mobile";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { recommendBacklog } from "../day-timeline";
import {
  mobileScheduleTaskPatch,
  mobileScheduledForDate,
  mobileTaskDayPeriod,
  mobileTaskDayRank,
  mobileUnscheduleTaskPatch,
} from "./mobile-day-model";

function task(
  id: string,
  data: Record<string, unknown>,
  createdAt = "2026-11-23T01:00:00.000Z",
): WorkspaceEntity {
  return {
    id,
    kind: "task",
    version: 1,
    deleted: false,
    createdAt,
    updatedAt: createdAt,
    data: { title: id, status: "todo", priority: 0, tags: [], ...data },
  };
}

describe("mobile-day-model", () => {
  test("resolves dayPeriod and dayRank from task data first and falls back to daily_plan_items", () => {
    const t1 = task("t1", { executionDate: "2026-11-23", dayPeriod: "evening", dayRank: 2 });
    const t2 = task("t2", { executionDate: "2026-11-23" });
    const planRow: WorkspaceEntity = {
      id: "plan-row-1",
      kind: "desktop_row",
      version: 1,
      deleted: false,
      createdAt: "2026-11-23T01:00:00.000Z",
      updatedAt: "2026-11-23T01:00:00.000Z",
      data: {
        table: "daily_plan_items",
        row: {
          task_id: "t2",
          execution_date: "2026-11-23",
          day_period: "afternoon",
          day_rank: 5,
          removed: 0,
          is_summary: 0,
        },
      },
    };
    const t3 = task("t3", { executionDate: "2026-11-23" });
    const entities = [t1, t2, t3, planRow];

    expect(mobileTaskDayPeriod(t1, "2026-11-23", entities)).toBe("evening");
    expect(mobileTaskDayRank(t1, "2026-11-23", entities)).toBe(2);
    expect(mobileTaskDayPeriod(t2, "2026-11-23", entities)).toBe("afternoon");
    expect(mobileTaskDayRank(t2, "2026-11-23", entities)).toBe(5);
    expect(mobileTaskDayPeriod(t3, "2026-11-23", entities)).toBe("morning");
    expect(mobileTaskDayRank(t3, "2026-11-23", entities)).toBe(0);
  });

  test("groups scheduled tasks by period and feeds desktop recommendBacklog cleanly", () => {
    const parent = task("p1", { title: "父任务", priority: 1 });
    const leaf1 = task("c1", {
      title: "子任务1",
      parentId: "p1",
      status: "completed",
      completedAt: "2026-11-22T10:00:00.000Z",
      desktop: { task_rank: 0 },
    });
    const leaf2 = task("c2", {
      title: "子任务2",
      parentId: "p1",
      status: "todo",
      desktop: { task_rank: 1 },
    });
    const scheduledMorning = task("m1", {
      title: "早上任务",
      executionDate: "2026-11-23",
      dayPeriod: "morning",
      dayRank: 2,
    });
    const scheduledMorningFirst = task("m0", {
      title: "更靠前的早上任务",
      executionDate: "2026-11-23",
      dayPeriod: "morning",
      dayRank: 1,
    });
    const scheduledEvening = task("e1", {
      title: "晚上任务",
      executionDate: "2026-11-23",
      dayPeriod: "evening",
    });
    const doneToday = task("d1", {
      title: "今日完成",
      status: "completed",
      completedAt: "2026-11-23T08:00:00+08:00",
    });
    const cancelled = task("x1", {
      title: "已取消",
      status: "cancelled",
      executionDate: "2026-11-23",
    });

    const entities = [
      parent,
      leaf1,
      leaf2,
      scheduledMorning,
      scheduledMorningFirst,
      scheduledEvening,
      doneToday,
      cancelled,
    ];
    const result = mobileScheduledForDate(entities, "2026-11-23", "Asia/Shanghai");

    expect(result.periods.morning.map((t) => t.id)).toEqual(["m0", "m1"]);
    expect(result.periods.afternoon).toEqual([]);
    expect(result.periods.evening.map((t) => t.id)).toEqual(["e1"]);
    expect(result.completed.map((t) => t.id)).toEqual(["d1"]);

    const work = mobilePersonalWork(
      { workspaceId: "local", entities, pendingOperations: 0 },
      "Asia/Shanghai",
    );
    const recommendations = recommendBacklog(
      work,
      result.dailyTasks,
      "2026-11-23",
      "Asia/Shanghai",
      10,
    );
    expect(recommendations.map((r) => r.task.id)).toEqual(["p1"]);
    expect(recommendations[0]?.actionTask.id).toBe("c2");
  });

  test("builds schedule and unschedule patches preserving existing fields", () => {
    const t = task("t1", {
      title: "写周报",
      notes: "重点列出进展",
      dayPeriod: "afternoon",
    });
    const scheduled = mobileScheduleTaskPatch(t, "2026-11-23");
    expect(scheduled.executionDate).toBe("2026-11-23");
    expect(scheduled.dayPeriod).toBe("afternoon");
    expect(scheduled.notes).toBe("重点列出进展");

    const moved = mobileScheduleTaskPatch(t, "2026-11-24", "evening");
    expect(moved.executionDate).toBe("2026-11-24");
    expect(moved.dayPeriod).toBe("evening");

    const unscheduled = mobileUnscheduleTaskPatch({ ...t, data: moved });
    expect(unscheduled.executionDate).toBeNull();
    expect(unscheduled.dayPeriod).toBe("evening");
  });
});
