import { expect, it, vi } from "vitest";
import {
  createRecoveringInvoke,
  type NativeInvoke,
} from "./native-recovery-policy";
import { createRecoveringMobileStorage } from "./mobile-storage-recovery";
import { recoverRead, replayOperation } from "./operation-recovery";

const invokePort =
  (
    handler: (command: string, args?: Record<string, unknown>) => unknown,
  ): NativeInvoke =>
  async <T>(command: string, args?: Record<string, unknown>) =>
    (await handler(command, args)) as T;

it("recovers a transient read and bounds persistent failures to two attempts", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(Error("IPC channel closed"))
    .mockResolvedValue(["task"]);
  await expect(recoverRead(read)).resolves.toEqual(["task"]);
  expect(read).toHaveBeenCalledTimes(2);
  const failure = Error("database unavailable");
  const offline = vi.fn().mockRejectedValue(failure);
  await expect(recoverRead(offline)).rejects.toBe(failure);
  expect(offline).toHaveBeenCalledTimes(2);
});

it.each([
  "STATE_CONFLICT",
  "USER:任务已更新",
  "账号已变化，请重新读取",
  "密码错误",
  "FORBIDDEN",
  "INVALID_DATE",
])("does not retry a definite rejection: %s", async (error) => {
  const read = vi.fn().mockRejectedValue(error);
  await expect(recoverRead(read)).rejects.toBe(error);
  expect(read).toHaveBeenCalledOnce();
  const send = vi.fn().mockRejectedValue(error);
  await expect(replayOperation(send, async () => true)).rejects.toBe(error);
  expect(send).toHaveBeenCalledOnce();
});

it("native snapshots recover without changing the command or arguments", async () => {
  const calls: unknown[] = [];
  const invoke = createRecoveringInvoke(
    invokePort((name, args) => {
      calls.push([name, args]);
      if (calls.length === 1) throw Error("fetch failed");
      return { tasks: ["task"] };
    }),
  );
  await expect(
    invoke("productivity_snapshot", { projectId: "project" }),
  ).resolves.toEqual({ tasks: ["task"] });
  expect(calls[1]).toEqual(calls[0]);
});

it("native writes replay the frozen operation once after a lost acknowledgement", async () => {
  const args = {
    command: {
      operationId: "operation",
      action: { type: "task", notes: "original draft" },
    },
  };
  const writes: unknown[] = [];
  const invoke = createRecoveringInvoke(
    invokePort((name, payload) => {
      if (name === "account_status")
        return { baseUrl: "https://fixture.test", user: { id: "owner" } };
      writes.push(structuredClone(payload));
      if (writes.length === 1) {
        args.command.action.notes = "new input";
        throw Error("IPC channel closed");
      }
      return "receipt";
    }),
  );
  await expect(invoke("productivity_command", args)).resolves.toBe("receipt");
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual(writes[0]);
  expect(writes[1]).toMatchObject({
    command: { operationId: "operation", action: { notes: "original draft" } },
  });
});

it("does not replay an uncertain write into a different account", async () => {
  let owner = "account-a",
    writes = 0;
  const failure = Error("connection closed");
  const invoke = createRecoveringInvoke(
    invokePort((name) => {
      if (name === "account_status")
        return { baseUrl: "https://fixture.test", user: { id: owner } };
      writes += 1;
      owner = "account-b";
      throw failure;
    }),
  );
  await expect(
    invoke("productivity_command", { command: { operationId: "operation" } }),
  ).rejects.toBe(failure);
  expect(writes).toBe(1);
});

it.each([
  "account_authenticate",
  "account_change_password",
  "backup_restore",
  "ai_gateway_request",
  "workspace_switch",
  "update_plan",
])("keeps %s outside automatic write replay", async (name) => {
  const raw = vi.fn().mockRejectedValue(Error("network timeout"));
  const invoke = createRecoveringInvoke(raw);
  await expect(
    invoke(name, { command: { operationId: "operation" } }),
  ).rejects.toThrow("network timeout");
  expect(raw).toHaveBeenCalledOnce();
});

it("never replays a command without an operation identity", async () => {
  const raw = vi.fn().mockRejectedValue(Error("IPC channel closed"));
  await expect(
    createRecoveringInvoke(raw)("productivity_command", {
      command: { action: "task" },
    }),
  ).rejects.toThrow();
  expect(raw).toHaveBeenCalledOnce();
});

it("does not replay when the account scope could not be established", async () => {
  let writes = 0;
  const invoke = createRecoveringInvoke(
    invokePort((name) => {
      if (name === "account_status") return {};
      writes += 1;
      throw Error("IPC channel closed");
    }),
  );
  await expect(
    invoke("productivity_command", { command: { operationId: "operation" } }),
  ).rejects.toThrow();
  expect(writes).toBe(1);
});

it("mobile storage recovers reads, preserves method receivers and replays the same receipt", async () => {
  const receipts = new Set<string>();
  let reads = 0;
  const writes: { operationId: string; text: string }[] = [];
  const raw = {
    workspaceList: async () => [{ id: "local", active: true }],
    async workspaceSnapshot() {
      reads += 1;
      if (reads === 1) throw Error("SQLITE_BUSY");
      return {
        count: receipts.size,
        workspace: (await this.workspaceList())[0]?.id,
      };
    },
    async workspaceCommand(command: { operationId: string; text: string }) {
      writes.push(structuredClone(command));
      if (receipts.has(command.operationId)) return { count: receipts.size };
      receipts.add(command.operationId);
      throw Error("connection closed");
    },
  };
  const storage = createRecoveringMobileStorage(raw);
  await expect(storage.workspaceSnapshot()).resolves.toEqual({
    count: 0,
    workspace: "local",
  });
  await expect(
    storage.workspaceCommand({ operationId: "operation", text: "draft" }),
  ).resolves.toEqual({ count: 1 });
  expect(writes[1]).toEqual(writes[0]);
  expect(receipts.size).toBe(1);
});

it("mobile storage does not replay into a changed workspace or retry imports", async () => {
  let workspace = "first",
    writes = 0,
    imports = 0;
  const raw = {
    workspaceList: async () => [{ id: workspace, active: true }],
    async workspaceCommand(_command: { operationId: string }) {
      writes += 1;
      workspace = "second";
      throw Error("connection closed");
    },
    async workspaceImport(_json: string, _operationId: string) {
      imports += 1;
      throw Error("connection closed");
    },
  };
  const storage = createRecoveringMobileStorage(raw);
  await expect(
    storage.workspaceCommand({ operationId: "operation" }),
  ).rejects.toThrow();
  await expect(storage.workspaceImport("{}", "operation")).rejects.toThrow();
  expect(writes).toBe(1);
  expect(imports).toBe(1);
});
