import { RetriableCommands } from "./retriable-commands";
export type RecordKind =
  | "note"
  | "idea"
  | "question"
  | "evidence"
  | "decision"
  | "progress"
  | "review";
export interface ContentLink {
  targetType: "project" | "task";
  targetId: string;
}
export interface CaptureItem {
  id: string;
  rawText: string;
  state: "pending" | "processed";
  version: number;
  createdAt: string;
  resolutionId: string | null;
  retainedOutputs: number;
}
export interface ContentRecord {
  weeklyReview?: boolean;
  id: string;
  title: string;
  body: string;
  recordType: RecordKind;
  version: number;
  sourceCaptureId: string | null;
  updatedAt: string;
  links: ContentLink[];
}
export interface ContentTask {
  id: string;
  title: string;
  projectId: string | null;
  status: string;
  version: number;
  sourceCaptureId: string | null;
  leaf: number;
}
export interface ProjectContext {
  projectId: string;
  definitionOfDone: string;
  blockerText: string;
  reviewDate: string | null;
  nextActionTaskId: string | null;
  lastContext: string;
  restartHint: string;
  waitingNote: string;
  version: number;
  updatedAt: string;
  nextActionCleared: number;
}
export interface ResolutionOutput {
  id: string;
  kind: "task" | "record";
  title: string;
  body: string;
}
export interface Resolution {
  id: string;
  captureId: string;
  outputs: ResolutionOutput[];
  undoneAt: string | null;
  kept: number;
}
export type ContentAction =
  | { type: "capture"; id: string; rawText: string }
  | {
      type: "record";
      id: string;
      expectedVersion: number | null;
      title: string;
      body: string;
      recordType: RecordKind;
      links: ContentLink[];
    }
  | {
      type: "resolve";
      captureId: string;
      expectedVersion: number;
      outputs: ResolutionOutput[];
      projectId: string | null;
      newProject: { id: string; name: string } | null;
    }
  | { type: "undo"; resolutionId: string; keepOutputs: boolean }
  | ({ type: "context"; expectedVersion: number | null } & Omit<
      ProjectContext,
      "version" | "updatedAt" | "nextActionCleared"
    >);
export interface ContentCommand {
  operationId: string;
  occurredAt: string;
  action: ContentAction;
}
export interface ContentSnapshot {
  captures: CaptureItem[];
  records: ContentRecord[];
  tasks: ContentTask[];
  contexts: ProjectContext[];
  resolutions: Resolution[];
  events: {
    id: string;
    entityId: string;
    kind: string;
    occurredAt: string;
    payload: ContentCommand;
  }[];
}
export const emptyContent: ContentSnapshot = {
  captures: [],
  records: [],
  tasks: [],
  contexts: [],
  resolutions: [],
  events: [],
};
export class ContentCommands {
  private retry = new RetriableCommands<ContentCommand>();
  constructor(private send: (command: ContentCommand) => Promise<void>) {}
  async save(action: ContentAction) {
    const key = action.type;
    await this.retry.execute(
      key,
      (c) => JSON.stringify(c.action) === JSON.stringify(action),
      () => ({
        operationId: crypto.randomUUID(),
        occurredAt: new Date().toISOString(),
        action,
      }),
      this.send,
    );
  }
}
