import { expect, it } from "vitest";
import { PersonalTaskRejectedError, type WorkTask } from "@praxis/application";
import { personalInlineEdit } from "./personal-task-editor";
const task: WorkTask = {
  id: "old",
  title: "原任务",
  notes: "旧说明",
  projectId: null,
  parentId: null,
  sectionId: null,
  status: "waiting",
  version: 9,
  deadline: {
    kind: "instant",
    atUtc: "2026-11-11T02:00:00Z",
    displayTimezone: "America/Los_Angeles",
  },
  plan: null,
  followUp: null,
  priority: 3,
  important: 1,
  waitingFor: "旧资料",
  waitingNote: "原等待说明",
  completedAt: null,
  createdAt: "2026-11-01T00:00:00Z",
  rank: 0,
  labels: [],
};
const draft = {
  title: task.title,
  notes: task.notes,
  date: "2026-11-10",
  editDeadline: false,
};
it("notes-only edits omit deadline/status and retain the original typed instant until an explicit replacement", () => {
  const before = structuredClone(task);
  expect(personalInlineEdit(task, { ...draft, notes: "新说明" })).toEqual({
    type: "edit",
    notes: "新说明",
  });
  expect(task).toEqual(before);
});
it("explicit same-day replacement and clearing are distinct from leaving the old instant untouched", () => {
  expect(personalInlineEdit(task, { ...draft, editDeadline: true })).toEqual({
    type: "edit",
    deadline: { kind: "date", date: "2026-11-10" },
  });
  expect(
    personalInlineEdit(task, { ...draft, date: "", editDeadline: true }),
  ).toEqual({ type: "edit", deadline: null });
  expect(personalInlineEdit(task, draft)).toEqual({ type: "edit" });
});
it("rejects empty names and invalid calendar dates locally without producing a write", () => {
  expect(() => personalInlineEdit(task, { ...draft, title: "  " })).toThrow(
    PersonalTaskRejectedError,
  );
  expect(() =>
    personalInlineEdit(task, {
      ...draft,
      date: "2026-02-30",
      editDeadline: true,
    }),
  ).toThrow(PersonalTaskRejectedError);
  expect(() =>
    personalInlineEdit(task, { ...draft, title: "任".repeat(501) }),
  ).toThrow("500");
});
