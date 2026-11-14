/** M0 protocol specification. Not wired to routes, existing storage or UI. */
export const MVP_PROTOCOL = "praxis-project-v2";
export const MVP_XP_RULE = "task-xp-v1";
export type TaskStatus = "todo" | "in_progress" | "completed";
export type ResourceScope =
  | { readonly kind: "personal"; readonly ownerId: string }
  | { readonly kind: "project"; readonly projectId: string };
export type Deadline =
  | { readonly kind: "date"; readonly date: string; readonly timeZone: string }
  | {
      readonly kind: "instant";
      readonly atUtc: string;
      readonly displayTimezone: string;
    };
export interface LegacyBinding {
  readonly serviceId: string;
  readonly legacyOwnerId: string;
  readonly legacyProjectId: string;
  readonly projectId: string;
}
export interface ProjectMember {
  readonly userId: string;
  readonly role: "creator" | "member";
  readonly version: number;
  readonly accessGeneration: number;
  readonly state: "active" | "removed";
}
export interface ProjectSnapshot {
  readonly projectId: string;
  readonly creatorId: string;
  readonly name: string;
  readonly goal: string;
  readonly targetDate: string | null;
  readonly timeZone: string;
  readonly version: number;
  readonly updatedAt: string;
  readonly statisticsMode: "flat" | "legacy-tree";
  readonly members: readonly ProjectMember[];
}
export interface TaskSnapshot {
  readonly scope: ResourceScope;
  readonly id: string;
  readonly createdBy: string;
  readonly assigneeId: string;
  readonly title: string;
  readonly notes: string;
  readonly status: TaskStatus;
  readonly deadline: Deadline | null;
  readonly version: number;
  readonly deletedAt: string | null;
  readonly completion: CompletionSnapshot | null;
}
export interface CompletionSnapshot {
  readonly id: string;
  readonly actorId: string;
  readonly recipientId: string;
  readonly completedAt: string | null;
  readonly origin: "observed" | "legacy-owner-inferred";
}
export interface NewTask {
  readonly id: string;
  readonly title: string;
  readonly notes: string;
  readonly assigneeId: string;
  readonly deadline: Extract<Deadline, { kind: "date" }> | null;
}
export interface VersionedTask {
  readonly taskId: string;
  readonly expectedVersion: number;
}
/** Actor, permissions, received time and XP recipient are supplied by trusted runtime. */
export interface CommandPayloads {
  "project.create": {
    projectId: string;
    name: string;
    goal: string;
    targetDate: string | null;
    timeZone: string;
  };
  "project.update": {
    expectedVersion: number;
    name: string;
    goal: string;
    targetDate: string | null;
  };
  "task.create": { tasks: readonly NewTask[] };
  "task.edit": VersionedTask & {
    title: string;
    notes: string;
    assigneeId: string;
    deadline: Deadline | null;
  };
  "task.status": VersionedTask & { status: TaskStatus };
  "task.delete": VersionedTask;
  "task.restore": VersionedTask & { deletionOperationId: string };
  "member.remove": {
    userId: string;
    expectedVersion: number;
    transferTo: string;
    expectedTaskVersions: readonly VersionedTask[];
  };
  "invitation.create": Record<string, never>;
  "invitation.revoke": { invitationId: string; expectedVersion: number };
  "ai.adopt": {
    runId: string;
    confirmationId: string;
    draftDigest: string;
    tasks: readonly NewTask[];
  };
}
export type CommandName = keyof CommandPayloads;
export type ProjectCommand = {
  [K in CommandName]: {
    readonly protocol: typeof MVP_PROTOCOL;
    readonly operationId: string;
    readonly deviceId: string;
    readonly projectId: string;
    readonly expectedAccessGeneration: number;
    readonly name: K;
    readonly payload: CommandPayloads[K];
  };
}[CommandName];
export interface TrustedExecutionContext {
  readonly serviceId: string;
  readonly actorId: string;
  readonly deviceId: string;
  readonly receivedAt: string;
}
export interface CommandReceipt {
  readonly protocol: typeof MVP_PROTOCOL;
  readonly operationId: string;
  readonly projectId: string;
  readonly actorId: string;
  readonly commandDigest: string;
  readonly committedAt: string;
  readonly changedTasks: readonly { id: string; version: number }[];
  readonly cursor: string;
}
export interface Confirmation {
  readonly id: string;
  readonly actorId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly draftDigest: string;
  readonly accessGeneration: number;
  readonly expiresAt: string;
  readonly consumedByOperationId: string | null;
}
export interface Invitation {
  readonly id: string;
  readonly projectId: string;
  readonly tokenHash: string;
  readonly version: number;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
}
/** Invitation join is a separate authenticated endpoint; caller is not a member yet. */
export interface JoinInvitation {
  readonly operationId: string;
  readonly deviceId: string;
  readonly token: string;
}
export interface ProjectChangePage {
  readonly accessGeneration: string;
  readonly cursor: string;
  readonly resetRequired: boolean;
  readonly revokedProjectIds: readonly string[];
  readonly tasks: readonly TaskSnapshot[];
}
export interface XpContribution {
  readonly scope: ResourceScope;
  readonly taskId: string;
  readonly completionId: string;
  readonly recipientId: string;
  readonly completedAt: string | null;
  readonly active: boolean;
}
export type CommandError =
  | "UNAUTHENTICATED"
  | "RESOURCE_FORBIDDEN"
  | "PROTOCOL_UNSUPPORTED"
  | "VERSION_CONFLICT"
  | "OPERATION_CHANGED"
  | "MEMBER_REQUIRED"
  | "CONFIRMATION_REQUIRED"
  | "CONFIRMATION_STALE"
  | "INVITATION_INVALID";
