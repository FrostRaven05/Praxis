import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  CaptureCommand,
  DailyTask,
  TaskStorage,
} from "@praxis/application";

export const desktopAvailable = isTauri();

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
