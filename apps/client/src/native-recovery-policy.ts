import {
  operationId,
  recoverRead,
  replayOperation,
} from "./operation-recovery";

export type NativeInvoke = <T>(
  command: string,
  args?: Record<string, unknown>,
) => Promise<T>;
const reads = new Set([
  "account_status",
  "read_theme_color",
  "list_day",
  "list_inbox",
  "list_projects",
  "project_tasks",
  "task_details",
  "day_load",
  "productivity_snapshot",
  "content_snapshot",
  "habit_snapshot",
  "recurrence_snapshot",
  "review_snapshot",
  "view_snapshot",
  "view_query",
  "trash_snapshot",
  "backup_list",
  "lan_sync_status",
  "lan_entity_snapshot",
  "lan_entity_conflicts",
  "ai_project_snapshot",
  "ai_receipt",
]);
const replayable = new Set([
  "capture_task",
  "capture_task_on_date",
  "change_completion",
  "edit_task",
  "set_capacity",
  "capture_inbox",
  "schedule_task",
  "accept_suggestion",
  "save_project",
  "add_project_tasks",
  "assign_project",
  "save_task_details",
  "add_subtasks",
  "project_workspace",
  "productivity_command",
  "content_command",
  "habit_command",
  "recurrence_command",
  "review_command",
  "trash_command",
  "lan_entity_edit",
]);

export function createRecoveringInvoke(raw: NativeInvoke): NativeInvoke {
  const scope = async () => {
    const status = await raw<{ baseUrl: string; user: { id: string } | null }>(
      "account_status",
    );
    if (
      !status ||
      typeof status.baseUrl !== "string" ||
      (status.user !== null && typeof status.user?.id !== "string")
    )
      return null;
    return JSON.stringify([status.baseUrl, status.user?.id ?? "local"]);
  };
  return async <T>(
    command: string,
    args?: Record<string, unknown>,
  ): Promise<T> => {
    if (reads.has(command)) return recoverRead(() => raw<T>(command, args));
    const payload = args?.command ?? args;
    if (!replayable.has(command) || !operationId(payload))
      return raw<T>(command, args);
    const frozen = args ? structuredClone(args) : undefined;
    // Capture ownership before sending. An account switch must never replay a write.
    const owner = await scope().catch(() => null);
    return replayOperation(
      () => raw<T>(command, frozen),
      async () => owner !== null && (await scope()) === owner,
    );
  };
}
