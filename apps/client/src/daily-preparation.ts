import { invoke } from "./native-recovery";

let pending: Promise<void> | null = null;
/** Both daily snapshots wait for the same committed rollover. */
export function prepareDailyTasks() {
  if (!pending) {
    pending = invoke<void>("prepare_daily_tasks", {
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }).finally(() => {
      pending = null;
    });
  }
  return pending;
}
