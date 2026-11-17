import { invoke } from "./native-recovery";
import { ContentCommands, type ContentSnapshot } from "@praxis/application";
export const contentCommands = new ContentCommands((command) =>
  invoke("content_command", { command }),
);
export const readContent = () => invoke<ContentSnapshot>("content_snapshot");
export const contentError = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
