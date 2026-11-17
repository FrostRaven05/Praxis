import { invoke, isTauri } from "./native-recovery";
import { Capacitor } from "@capacitor/core";
import { type WorkSnapshot } from "@praxis/application";
import {
  mobileStorage,
  mobileDatabaseName,
} from "./mobile-storage";
import { accountStorage } from "./account-storage";
import { prepareDailyTasks } from "./daily-preparation";
import {
  createDesktopPersonalTasks,
  createMobilePersonalTasks,
} from "./personal-task-adapters";
const scope = async () => {
  const account = await accountStorage.status();
  return JSON.stringify([account.baseUrl, account.user?.id ?? "local"]);
};
export const personalTasks = Capacitor.isNativePlatform()
  ? createMobilePersonalTasks({
      workspaceSnapshot: () => mobileStorage.workspaceSnapshot(),
      workspaceList: () => mobileStorage.workspaceList(),
      workspaceCommand: (c) => mobileStorage.workspaceCommand(c),
      scope: async () =>
        JSON.stringify([await scope(), await mobileDatabaseName()]),
      fallbackZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    })
  : createDesktopPersonalTasks({
      scope,
      fallbackZone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
      read: async () => {
        if (!isTauri()) throw Error("请在 Praxis 应用中读取个人任务");
        return invoke<WorkSnapshot>("productivity_snapshot");
      },
      send: (command) => invoke<void>("productivity_command", { command }),
      readTrash: () => invoke("trash_snapshot"),
      sendTrash: (command) => invoke<void>("trash_command", { command }),
    });
export const readPersonalWork = async () => {
  const result = await personalTasks.read();
  return { ...result.work, tasks: result.query.tasks };
};
/** Preserve the existing desktop daily preparation before the homepage snapshot. */
export const personalTodoTasks = {
  ...personalTasks,
  read: async () => {
    if (isTauri()) await prepareDailyTasks();
    return personalTasks.read();
  },
};
