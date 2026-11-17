import { invoke as rawInvoke } from "@tauri-apps/api/core";
import { createRecoveringInvoke } from "./native-recovery-policy";
export { isTauri } from "@tauri-apps/api/core";

export const invoke = createRecoveringInvoke(rawInvoke);
