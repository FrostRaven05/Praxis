import { createContext } from "react";

export const ProjectTaskPanelContext = createContext<{
  selectedTaskId: string | null;
  disabled: boolean;
  open: (taskId: string, trigger: HTMLButtonElement) => Promise<void>;
} | null>(null);
