import type { SaveProjectCommand } from "@praxis/application";
import type { WorkspaceCommand, WorkspaceEntity } from "@praxis/storage-mobile";

/** Replace only the three basic fields; keep lifecycle, recovery and opaque extensions. */
export function mobileProjectCommand(
  entity: WorkspaceEntity,
  workspaceId: string,
  command: SaveProjectCommand,
): WorkspaceCommand {
  return {
    operationId: command.operationId,
    occurredAt: command.occurredAt,
    expectedWorkspaceId: workspaceId,
    changes: [
      {
        id: command.projectId,
        kind: "project",
        expectedVersion: command.expectedVersion,
        data: {
          ...entity.data,
          title: command.name,
          outcome: command.outcome,
          dueDate: command.targetDate,
        },
      },
    ],
  };
}
