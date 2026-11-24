import { describe, expect, test } from "vitest";
import { WorkspaceRejectedError } from "@praxis/storage-mobile";
import { createPreviewMobileStorage } from "./preview-storage";

function memoryStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
  };
}

describe("createPreviewMobileStorage", () => {
  test("seeds initial personal project, scheduled tasks, and todos", async () => {
    const api = createPreviewMobileStorage(
      memoryStorage(),
      () => new Date("2026-11-23T09:00:00+08:00"),
    );
    const workspaces = await api.workspaceList();
    expect(workspaces).toEqual([
      { id: "local", title: "本地预览工作空间", active: true },
    ]);

    const snapshot = await api.workspaceSnapshot();
    expect(snapshot.workspaceId).toBe("local");
    expect(snapshot.entities.some((e) => e.kind === "project")).toBe(true);
    expect(
      snapshot.entities.some(
        (e) =>
          e.kind === "task" &&
          e.data.executionDate === "2026-11-23" &&
          e.data.dayPeriod === "morning",
      ),
    ).toBe(true);
  });

  test("increments versions, enforces expectedVersion, and replays idempotent operations", async () => {
    const api = createPreviewMobileStorage(
      memoryStorage(),
      () => new Date("2026-11-23T09:00:00+08:00"),
    );
    const taskId = "90000000-0000-4000-8000-000000000001";
    const operationId = "90000000-0000-4000-8000-000000000002";
    const command = {
      operationId,
      occurredAt: "2026-11-23T09:05:00.000Z",
      expectedWorkspaceId: "local",
      changes: [
        {
          id: taskId,
          kind: "task" as const,
          expectedVersion: null,
          data: {
            title: "验证预览写入",
            status: "todo",
            executionDate: "2026-11-23",
            dayPeriod: "evening",
            priority: 0,
            tags: [],
          },
        },
      ],
    };

    const first = await api.workspaceCommand(command);
    expect(first.entities.find((e) => e.id === taskId)?.version).toBe(1);

    // Same operationId + identical payload replays cleanly without bumping version.
    const replay = await api.workspaceCommand(command);
    expect(replay.entities.find((e) => e.id === taskId)?.version).toBe(1);

    // Different payload with same operationId is rejected.
    await expect(
      api.workspaceCommand({
        ...command,
        changes: [
          {
            ...command.changes[0]!,
            data: { ...command.changes[0]!.data, title: "篡改内容" },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(WorkspaceRejectedError);

    // Stale expectedVersion is rejected.
    await expect(
      api.workspaceCommand({
        operationId: "90000000-0000-4000-8000-000000000003",
        occurredAt: "2026-11-23T09:06:00.000Z",
        changes: [
          {
            id: taskId,
            kind: "task",
            expectedVersion: 2,
            data: { title: "冲突", status: "todo", priority: 0, tags: [] },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(WorkspaceRejectedError);
  });

  test("cascade deletes subtasks and restores them together", async () => {
    const api = createPreviewMobileStorage(
      memoryStorage(),
      () => new Date("2026-11-23T09:00:00+08:00"),
    );
    const snap1 = await api.workspaceSnapshot();
    const parent = snap1.entities.find(
      (e) => e.kind === "task" && e.data.title === "重构首页排版",
    )!;
    const child = snap1.entities.find(
      (e) => e.kind === "task" && e.data.parentId === parent.id,
    )!;

    await api.workspaceCommand({
      operationId: "90000000-0000-4000-8000-000000000010",
      occurredAt: "2026-11-23T09:10:00.000Z",
      changes: [
        {
          id: parent.id,
          kind: "task",
          expectedVersion: parent.version,
          data: parent.data,
          deleted: true,
        },
      ],
    });
    const snap2 = await api.workspaceSnapshot();
    expect(snap2.entities.find((e) => e.id === parent.id)?.deleted).toBe(true);
    expect(snap2.entities.find((e) => e.id === child.id)?.deleted).toBe(true);

    const deletedParent = snap2.entities.find((e) => e.id === parent.id)!;
    await api.workspaceCommand({
      operationId: "90000000-0000-4000-8000-000000000011",
      occurredAt: "2026-11-23T09:11:00.000Z",
      changes: [
        {
          id: deletedParent.id,
          kind: "task",
          expectedVersion: deletedParent.version,
          data: deletedParent.data,
          deleted: false,
        },
      ],
    });
    const snap3 = await api.workspaceSnapshot();
    expect(snap3.entities.find((e) => e.id === parent.id)?.deleted).toBe(false);
    expect(snap3.entities.find((e) => e.id === child.id)?.deleted).toBe(false);
  });
});
