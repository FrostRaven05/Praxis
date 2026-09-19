import { ProjectWorkspace } from "@praxis/application";
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

export const planningStorage: import("@praxis/application").PlanningStorage = {
  updatePlan: (command) => invoke("update_plan", { command }),
  dayLoad: (date) => invoke("day_load", { date }),
  setCapacity: (command) => invoke("set_capacity", { command }),
  captureInbox: (command) => invoke("capture_inbox", { command }),
  listInbox: () => invoke("list_inbox"),
  scheduleTask: (command) => invoke("schedule_task", { command }),
};

export const projectStorage: import("@praxis/application").ProjectStorage = {
  listProjects: () => invoke("list_projects"),
  projectTasks: (projectId) => invoke("project_tasks", { projectId }),
  saveProject: (command) => invoke("save_project", { command }),
  addProjectTasks: (command) => invoke("add_project_tasks", { command }),
  assignProject: (command) => invoke("assign_project", { command }),
};

export const taskDetailsStorage: import("@praxis/application").TaskDetailsStorage =
  {
    read: (taskId) => invoke("task_details", { taskId }),
    save: (command) => invoke("save_task_details", { command }),
  };

export const subtaskStorage: import("@praxis/application").SubtaskStorage = {
  add: (command) => invoke("add_subtasks", { command }),
};

export const workspace = new ProjectWorkspace((command) =>
  invoke("project_workspace", { command }),
);
