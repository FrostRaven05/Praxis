import { invoke } from "@tauri-apps/api/core";

let pending: Promise<void> | null = null;
/** Both daily snapshots wait for the same committed rollover. */
export function prepareDailyTasks() {
  if (!pending) {
    pending = invoke<void>("prepare_daily_tasks").finally(() => {
      pending = null;
    });
  }
  return pending;
}
