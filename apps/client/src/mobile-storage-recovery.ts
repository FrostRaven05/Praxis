import {
  operationId,
  recoverRead,
  replayOperation,
} from "./operation-recovery";

const reads = new Set([
  "workspaceSnapshot",
  "workspaceList",
  "workspaceExport",
  "listDay",
  "listCaptures",
  "captureQueueCount",
  "entityState",
  "lanState",
]);
const replayable = new Set(["workspaceCommand", "saveCapture", "capture"]);

export function createRecoveringMobileStorage<
  T extends { workspaceList(): Promise<{ id: string; active: boolean }[]> },
>(storage: T): T {
  const methods = new Map<PropertyKey, unknown>();
  return new Proxy(storage, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      if (!methods.has(key))
        methods.set(key, async (...args: unknown[]) => {
          const call = () => value.apply(target, args);
          if (reads.has(String(key))) return recoverRead(call);
          if (!replayable.has(String(key)) || !operationId(args[0]))
            return call();
          const frozen = structuredClone(args);
          const scope = async () =>
            (await target.workspaceList()).find((workspace) => workspace.active)
              ?.id;
          const workspace = await scope().catch(() => undefined);
          return replayOperation(
            () => value.apply(target, frozen),
            async () =>
              workspace !== undefined && (await scope()) === workspace,
          );
        });
      return methods.get(key);
    },
  });
}
