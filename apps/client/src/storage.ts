import { Capacitor } from "@capacitor/core";
import { mobileStorage } from "../../../packages/storage-mobile/src/native";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  CaptureCommand,
  DailyTask,
  TaskStorage,
} from "@praxis/application";

export const desktopAvailable = isTauri();
export const nativeAvailable = desktopAvailable || Capacitor.isNativePlatform();

export const desktopStorage: TaskStorage = {
  async capture(command: CaptureCommand): Promise<DailyTask> {
    if (!desktopAvailable)
      throw new Error(
        "请在 Praxis 桌面应用中录入任务。浏览器预览不会保存任务。",
      );
    return invoke<DailyTask>("capture_task", { command });
  },
  async listDay(date: string): Promise<DailyTask[]> {
    if (!desktopAvailable)
      throw new Error("当前为浏览器预览。请打开桌面应用查看本机任务。");
    return invoke<DailyTask[]>("list_day", { date });
  },
};

export const taskStorage = Capacitor.isNativePlatform()
  ? mobileStorage
  : desktopStorage;

export const completionStorage: import("@praxis/application").CompletionStorage =
  {
    async changeCompletion(command) {
      if (!desktopAvailable) throw new Error("当前设备暂不支持完成操作");
      return invoke<DailyTask>("change_completion", { command });
    },
  };

export const editStorage: import("@praxis/application").EditStorage = {
  async editTask(command) {
    if (!desktopAvailable) throw new Error("当前设备暂不支持任务编辑");
    return invoke<DailyTask>("edit_task", { command });
  },
};
