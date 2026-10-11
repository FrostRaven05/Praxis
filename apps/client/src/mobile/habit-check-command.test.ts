import { expect, it } from "vitest";
import { habitCheckCommand } from "./habit-check-command";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
it("restores a previously undone daily check with explicit CAS and the same identity", () => {
  const prior: WorkspaceEntity = {
    id: crypto.randomUUID(),
    kind: "habit_check",
    version: 5,
    deleted: true,
    createdAt: "2026-10-11T00:00:00Z",
    updatedAt: "2026-10-11T00:01:00Z",
    data: {
      habitId: "habit",
      date: "2026-10-11",
      status: "done",
      desktop: { extra: "keep" },
    },
  };
  const next = habitCheckCommand(
    [prior],
    "habit",
    "2026-10-11",
    "skipped",
    "UTC",
    "2026-10-11T00:02:00Z",
    "2026-10-01",
  );
  expect(next).toMatchObject({
    id: prior.id,
    expectedVersion: 5,
    deleted: false,
    data: { status: "skipped", desktop: { extra: "keep" } },
  });
  expect(
    habitCheckCommand(
      [],
      "habit",
      "2026-10-11",
      "done",
      "UTC",
      "2026-10-11T00:02:00Z",
      "2026-10-01",
    ).expectedVersion,
  ).toBeNull();
});
