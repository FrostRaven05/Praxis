import { expect, it, vi } from "vitest";
import {
  Planning,
  planChange,
  type DailyTask,
  type PlanningStorage,
} from "@praxis/application";
import type { PlanCommand } from "../../../packages/application/src/planning";
import type { Row as HabitRow } from "./HabitsView";
import {
  createDayPlanRequest,
  DayPlanSaveError,
  saveDayPlan,
  type DayPlanSnapshot,
} from "./day-planning";

const date = "2026-11-17";
const task: DailyTask = {
  taskId: "task",
  planId: "plan",
  title: "Task",
  executionDate: date,
  createdAt: "2026-11-17T00:00:00Z",
  projectId: null,
  source: "temporary",
  status: "todo",
  version: 1,
  isFocus: false,
  focusRank: 0,
  dayPeriod: "morning",
  dayRank: 1,
  estimatedMinutes: null,
};
const snapshot = (...tasks: DailyTask[]): DayPlanSnapshot => ({
  tasks,
  habits: [],
});

it("rebases a star onto the latest version without overwriting concurrent placement or estimates", async () => {
  const request = createDayPlanRequest(
    date,
    { type: "focus", taskId: task.taskId, planId: task.planId, isFocus: true },
    snapshot(task),
  )!;
  const latest = {
    ...task,
    version: 2,
    dayPeriod: "evening" as const,
    dayRank: 4,
    estimatedMinutes: 35,
  };
  const write = vi
    .fn()
    .mockRejectedValueOnce("安排已发生变化，请刷新后重试。")
    .mockResolvedValue(undefined);
  const read = vi.fn().mockResolvedValue(snapshot(latest));
  await expect(saveDayPlan(request, { write, read })).resolves.toBe("saved");
  expect(write).toHaveBeenLastCalledWith(
    date,
    [{ ...latestPlan(latest), isFocus: true }],
    [],
  );
  expect(read).toHaveBeenCalledOnce();
});

function latestPlan(row: DailyTask) {
  return {
    taskId: row.taskId,
    planId: row.planId,
    expectedVersion: row.version,
    isFocus: row.isFocus,
    focusRank: row.focusRank,
    dayPeriod: row.dayPeriod,
    dayRank: row.dayRank,
    estimatedMinutes: row.estimatedMinutes,
  };
}

it("recomputes a drag against fresh neighbours, including concurrently added tasks", async () => {
  const anchor = {
    ...task,
    taskId: "anchor-task",
    planId: "anchor",
    dayRank: 2,
  };
  const intent = {
    type: "move" as const,
    key: task.planId,
    period: "morning" as const,
    anchorId: anchor.planId,
    position: "after" as const,
  };
  const request = createDayPlanRequest(date, intent, snapshot(task, anchor))!;
  const inserted = { ...task, taskId: "new-task", planId: "new", dayRank: 2 };
  const latest = snapshot({ ...task, version: 3 }, inserted, {
    ...anchor,
    version: 4,
    dayRank: 3,
    isFocus: true,
  });
  const write = vi
    .fn()
    .mockRejectedValueOnce(Error("STATE_CONFLICT"))
    .mockResolvedValue(undefined);
  await saveDayPlan(request, { write, read: async () => latest });
  const changes = write.mock.calls[1]![1];
  expect(changes.map((change: { planId: string }) => change.planId)).toEqual([
    "new",
    "anchor",
    "plan",
  ]);
  expect(
    changes.find((change: { planId: string }) => change.planId === "anchor"),
  ).toMatchObject({ expectedVersion: 4, isFocus: true, dayRank: 2 });
});

it("does not write removed or completed tasks when recovering a rejected request", async () => {
  const request = createDayPlanRequest(
    date,
    { type: "focus", taskId: task.taskId, planId: task.planId, isFocus: true },
    snapshot(task),
  )!;
  const write = vi.fn().mockRejectedValue("STATE_CONFLICT");
  await expect(
    saveDayPlan(request, {
      write,
      read: async () => snapshot({ ...task, status: "completed", version: 2 }),
    }),
  ).resolves.toBe("changed");
  expect(write).toHaveBeenCalledOnce();
});

it("bounds recovery under continuous conflicts and retains the latest intent for retry", async () => {
  const request = createDayPlanRequest(
    date,
    { type: "focus", taskId: task.taskId, planId: task.planId, isFocus: true },
    snapshot(task),
  )!;
  let version = 1;
  const write = vi.fn().mockRejectedValue("STATE_CONFLICT");
  const error = await saveDayPlan(request, {
    write,
    read: async () => snapshot({ ...task, version: ++version }),
  }).catch((error: unknown) => error);
  expect(write).toHaveBeenCalledTimes(3);
  expect(error).toBeInstanceOf(DayPlanSaveError);
  expect((error as DayPlanSaveError).pending.changes[0]?.expectedVersion).toBe(
    4,
  );
});

it("automatically replays the exact operation after a lost acknowledgement without rebasing or duplicating writes", async () => {
  const commands: PlanCommand[] = [];
  const storage = {
    updatePlan: async (command: PlanCommand) => {
      commands.push(command);
      if (commands.length === 1) throw Error("lost response");
    },
  } as PlanningStorage;
  const planning = new Planning(storage);
  const request = createDayPlanRequest(
    date,
    { type: "focus", taskId: task.taskId, planId: task.planId, isFocus: true },
    snapshot(task),
  )!;
  const read = vi.fn();
  const port = { write: planning.update.bind(planning), read };
  await expect(saveDayPlan(request, port)).resolves.toBe("saved");
  expect(commands[1]).toEqual(commands[0]);
  expect(read).not.toHaveBeenCalled();
});

it("preserves the exact command for manual retry after two uncertain responses", async () => {
  const commands: PlanCommand[] = [];
  const storage = {
    updatePlan: async (command: PlanCommand) => {
      commands.push(command);
      if (commands.length < 3) throw Error("offline");
    },
  } as PlanningStorage;
  const planning = new Planning(storage);
  const request = createDayPlanRequest(
    date,
    { type: "focus", taskId: task.taskId, planId: task.planId, isFocus: true },
    snapshot(task),
  )!;
  const read = vi.fn();
  const port = { write: planning.update.bind(planning), read };
  const error = await saveDayPlan(request, port).catch(
    (error: DayPlanSaveError) => error,
  );
  expect(error).toBeInstanceOf(DayPlanSaveError);
  expect(commands).toHaveLength(2);
  await saveDayPlan((error as DayPlanSaveError).pending, port);
  expect(commands[2]).toEqual(commands[0]);
  expect(read).not.toHaveBeenCalled();
});

const habit: HabitRow = {
  placement: { dayPeriod: "morning", dayRank: 1, version: null },
  habit: {
    id: "habit",
    name: "Habit",
    notes: "",
    triggerContext: "",
    normalVersion: "",
    minimumVersion: "",
    projectId: null,
    startDate: date,
    createdAt: task.createdAt,
    version: 1,
  },
  rules: [],
  entry: null,
  schedule: null,
  applicable: true,
  collapsed: false,
  week: {
    from: date,
    until: date,
    done: 0,
    target: 1,
    skipped: 0,
    remainingDates: [date],
    state: "active",
    incomplete: true,
  },
};

it.each([new Error("STATE_CONFLICT"), "安排已发生变化，请刷新后重试。"])(
  "clears a confirmed rejected command before preparing another operation (%s)",
  async (conflict) => {
    const commands: PlanCommand[] = [];
    const storage = {
      updatePlan: async (command: PlanCommand) => {
        commands.push(command);
        if (commands.length === 1) throw conflict;
      },
    } as PlanningStorage;
    const planning = new Planning(storage);
    const changes = [
      {
        ...planChange(task),
        expectedVersion: 1,
        isFocus: true,
        focusRank: 0,
        estimatedMinutes: null,
      },
    ];
    await expect(planning.update(date, changes)).rejects.toBe(conflict);
    await planning.update(date, changes);
    expect(commands[1]?.operationId).not.toBe(commands[0]?.operationId);
  },
);

it("recovers a stale habit placement version without modifying its check-in", async () => {
  const intent = {
    type: "move" as const,
    key: "habit:habit",
    period: "evening" as const,
    position: "after" as const,
  };
  const request = createDayPlanRequest(date, intent, {
    tasks: [task],
    habits: [habit],
  })!;
  const write = vi
    .fn()
    .mockRejectedValueOnce("安排已发生变化，请刷新后重试。")
    .mockResolvedValue(undefined);
  const latest = { ...habit, placement: { ...habit.placement, version: 4 } };
  await saveDayPlan(request, {
    write,
    read: async () => ({ tasks: [task], habits: [latest] }),
  });
  expect(write.mock.calls[1]?.[2]).toEqual([
    { habitId: "habit", expectedVersion: 4, dayPeriod: "evening", dayRank: 1 },
  ]);
  expect(latest.entry).toBeNull();
});
