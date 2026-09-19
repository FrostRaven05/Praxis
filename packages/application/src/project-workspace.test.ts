import { ProjectWorkspace } from "./project-workspace";
import { describe, it, expect } from "vitest";
import {
  previewSchedule,
  shiftDate,
  projectEligible,
} from "./project-workspace";
const entries = [
  { taskId: "a", start: "2026-09-19", end: "2026-09-20", dependencies: [] },
  { taskId: "b", start: "2026-09-21", end: "2026-09-22", dependencies: ["a"] },
  { taskId: "c", start: "2026-09-23", end: "2026-09-23", dependencies: ["b"] },
];
describe("project schedule", () => {
  it("previews cascading delays without mutating original or shortening duration", () => {
    const next = previewSchedule(entries, {
      ...entries[0]!,
      end: "2026-09-23",
    });
    expect(next[1]!.start).toBe("2026-09-24");
    expect(next[1]!.end).toBe("2026-09-25");
    expect(next[2]!.start).toBe("2026-09-26");
    expect(entries[1]!.start).toBe("2026-09-21");
  });
  it("rejects cycles and invalid date windows", () => {
    expect(() =>
      previewSchedule(entries, { ...entries[0]!, dependencies: ["c"] }),
    ).toThrow();
    expect(() =>
      previewSchedule(entries, { ...entries[0]!, start: "2026-09-25" }),
    ).toThrow();
  });
  it("keeps unscheduled tasks unscheduled and handles calendar boundaries", () => {
    const n = previewSchedule(
      [
        ...entries,
        { taskId: "d", start: null, end: null, dependencies: ["a"] },
      ],
      entries[0]!,
    );
    expect(n[3]!.start).toBeNull();
    expect(shiftDate("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("only active projects participate in future suggestions", () => {
    expect(projectEligible("active")).toBe(true);
    for (const s of ["draft", "paused", "completed", "archived"])
      expect(projectEligible(s)).toBe(false);
  });
});

it("rejects invalid workspace actions before persistence and retries ambiguous saves with stable IDs", async () => {
  const sent: import("./project-workspace").WorkspaceCommand[] = [];
  const usecase = new ProjectWorkspace(async (c) => {
    sent.push(c);
    if (sent.length === 1) throw Error("lost response");
  });
  await expect(
    usecase.execute({
      kind: "status",
      taskId: "a",
      expectedVersion: 0,
      status: "blocked",
      reason: " ",
      date: "2026-09-19",
      timeZone: "Asia/Hong_Kong",
    }),
  ).rejects.toThrow("原因");
  await expect(
    usecase.execute({
      kind: "lifecycle",
      projectId: "p",
      expectedVersion: 0,
      status: "active",
      focused: false,
      arrangements: "remove",
      date: "2026-09-19",
    }),
  ).rejects.toThrow("暂停");
  expect(sent).toHaveLength(0);
  const action = {
    kind: "status" as const,
    taskId: "a",
    expectedVersion: 0,
    status: "blocked",
    reason: "等待资料",
    date: "2026-09-19",
    timeZone: "Asia/Hong_Kong",
  };
  await expect(usecase.execute(action)).rejects.toThrow("lost response");
  await usecase.execute(action);
  expect(sent[1]).toEqual(sent[0]);
});
