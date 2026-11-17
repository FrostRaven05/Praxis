export function installPlanningFixture() {
  const fixture = window.__todoFixture;
  const task = fixture
    .current()
    .tasks.find(
      (row) => row.status === "todo" && !row.deleted && !row.parentId,
    );
  task.title = "安排冲突回归任务";
  task.plan = { kind: "date", date: fixture.today };
  fixture.plan = {
    taskId: task.id,
    planId: "19000000-0000-4000-8000-000000000099",
    title: task.title,
    executionDate: fixture.today,
    completionDate: null,
    status: "todo",
    statusReason: "",
    version: task.version,
    createdAt: task.createdAt,
    isFocus: false,
    focusRank: 0,
    dayPeriod: "morning",
    dayRank: 1,
    estimatedMinutes: null,
    important: false,
    projectId: null,
    parentTaskId: null,
  };
  fixture.planCommands = [];
  fixture.planFault = null;
  fixture.dayReads = 0;
  const receipts = new Set();
  const invoke = window.__TAURI_INTERNALS__.invoke;
  window.__TAURI_INTERNALS__.invoke = async (name, args = {}) => {
    if (name === "habit_snapshot" && fixture.failHabitReadOnce) {
      fixture.failHabitReadOnce = false;
      throw Error("synthetic habit snapshot failure");
    }
    if (name === "list_day") {
      fixture.dayReads += 1;
      const rows =
        args.date === fixture.today ? [structuredClone(fixture.plan)] : [];
      if (fixture.pauseNextDayRead) {
        fixture.pauseNextDayRead = false;
        return new Promise((resolve) => {
          fixture.releaseDayRead = () => {
            resolve(rows);
            fixture.releaseDayRead = null;
          };
        });
      }
      return rows;
    }
    if (name === "update_plan") {
      const command = structuredClone(args.command);
      fixture.planCommands.push(command);
      if (fixture.planFault === "offline") throw Error("synthetic offline");
      if (receipts.has(command.operationId)) return;
      if (fixture.planFault === "conflict") {
        fixture.plan.version += 1;
        throw "安排已发生变化，请刷新后重试。";
      }
      for (const change of command.changes) {
        if (change.expectedVersion !== fixture.plan.version)
          throw "安排已发生变化，请刷新后重试。";
      }
      for (const change of command.changes) {
        Object.assign(fixture.plan, change, {
          version: fixture.plan.version + 1,
        });
      }
      receipts.add(command.operationId);
      if (fixture.planFault === "unknown") {
        fixture.planFault = null;
        throw Error("synthetic lost acknowledgement");
      }
      return;
    }
    return invoke(name, args);
  };
}
