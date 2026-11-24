/** Pure shared protocol for the first Praxis planner. Never contains credentials. */
export type AiMode = "clarify" | "decompose" | "resume";
export interface AiSource {
  id: string;
  version: number;
  rawText: string;
}
export interface AiProject {
  id: string;
  name: string;
  outcome: string;
  version: number;
  planVersion: number;
}
export interface AiContextTask {
  id: string;
  title: string;
  status: string;
  version: number;
  parentId?: string | null;
  dependencies: string[];
  estimatedMinutes: number | null;
  completionCriteria?: string;
  statusReason?: string;
  plannedStart?: string | null;
  plannedEnd?: string | null;
  executionDate?: string | null;
}
export interface AiProjectRecovery {
  version: number;
  updatedAt: string;
  definitionOfDone: string;
  blockerText: string;
  lastContext: string;
  restartHint: string;
  waitingNote: string;
  reviewDate: string | null;
  nextActionTaskId: string | null;
  nextActionCleared: boolean;
}
export interface AiContextRecord {
  id: string;
  version: number;
  title: string;
  recordType: string;
  bodyExcerpt: string;
  updatedAt: string;
  truncated: boolean;
}
export interface AiReference {
  kind: "recovery" | "record" | "task";
  id: string;
  version: number;
}
export interface AiGenerateRequest {
  id: string;
  mode: AiMode;
  input: string;
  constraints: string;
  context: {
    date: string;
    timeZone: string;
    project: AiProject | null;
    tasks: AiContextTask[];
    source: AiSource | null;
    recovery?: AiProjectRecovery | null;
    recentRecords?: AiContextRecord[];
    truncated?: boolean;
    availableMinutes?: number | null;
    /** Opt-in personal MVP; absent on legacy clients and saved drafts. */
    personal?: {
      scope: "project" | "new_project" | "todos";
      readAt: string;
      candidateTaskIds?: string[];
    };
  };
}
export interface AiDraftTask {
  key: string;
  title: string;
  criteria: string;
  estimatedMinutes: number | null;
  dependsOn: string[];
  parentKey?: string | null;
  notes?: string;
  deadline?: string | null;
}
export interface AiReward {
  title: string;
  condition: string;
}
export interface AiProposal {
  summary: string;
  projectName: string;
  outcome: string;
  assumptions: string[];
  question: string | null;
  nextAction: string;
  tasks: AiDraftTask[];
  reward: AiReward | null;
  suggestedTaskId: string | null;
  references?: AiReference[];
}
export interface AiRun {
  id: string;
  mode: AiMode;
  status: "running" | "ready" | "needs_input" | "failed" | "cancelled";
  proposal: AiProposal | null;
  error: { code: string; message: string } | null;
  createdAt: string;
  updatedAt: string;
  sourceDigest: string;
  model: string | null;
}
export interface AiScheduleToday {
  taskId: string;
  date: string;
  timeZone: string;
}
export interface AiApplyCommand {
  operationId: string;
  runId: string;
  input: string;
  source: AiSource | null;
  project: { id: string; version: number; planVersion: number } | null;
  newProject: { id: string; name: string; outcome: string } | null;
  basisTasks: { id: string; version: number }[];
  tasks: (AiDraftTask & { id: string })[];
  reward: AiReward | null;
  scheduleToday?: AiScheduleToday | null;
  basisRecovery?: {
    version: number | null;
    records: { id: string; version: number }[];
  };
}
export interface AiApplyReceipt {
  operationId: string;
  taskIds: string[];
  projectId: string | null;
  sourceCaptureId: string;
  resolutionId: string;
  appliedAt: string;
  undone: boolean;
}
export const AI_MAX_REQUEST_BYTES = 120_000;
export const AI_MAX_INPUT = 8000;
export const AI_MAX_TASKS = 20;
export const uuidPattern =
  "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$";
const text = (maxLength: number, minLength = 0) => ({
  type: "string",
  minLength,
  maxLength,
});
const object = (
  properties: Record<string, unknown>,
  required = Object.keys(properties),
) => ({ type: "object", additionalProperties: false, required, properties });
const array = (items: unknown, maxItems: number) => ({
  type: "array",
  items,
  maxItems,
});
const nullable = (value: unknown) => ({ anyOf: [value, { type: "null" }] });
const id = { type: "string", pattern: uuidPattern };
const version = { type: "integer", minimum: 0 };
const minutes = nullable({ type: "integer", minimum: 1, maximum: 480 });
const day = { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" };
export const aiRequestSchema = object({
  id,
  mode: { type: "string", enum: ["clarify", "decompose", "resume"] },
  input: text(AI_MAX_INPUT, 1),
  constraints: text(2000),
  context: object(
    {
      date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      timeZone: text(80, 1),
      project: nullable(
        object({
          id,
          name: text(500, 1),
          outcome: text(4000),
          version,
          planVersion: version,
        }),
      ),
      tasks: array(
        object(
          {
            id,
            title: text(500, 1),
            status: {
              type: "string",
              enum: [
                "todo",
                "in_progress",
                "blocked",
                "waiting",
                "completed",
                "cancelled",
              ],
            },
            version,
            dependencies: array(id, 100),
            estimatedMinutes: nullable({
              type: "integer",
              minimum: 1,
              maximum: 1440,
            }),
            parentId: nullable(id),
            completionCriteria: text(400),
            statusReason: text(600),
            plannedStart: nullable(day),
            plannedEnd: nullable(day),
            executionDate: nullable(day),
          },
          [
            "id",
            "title",
            "status",
            "version",
            "dependencies",
            "estimatedMinutes",
          ],
        ),
        100,
      ),
      source: nullable(object({ id, version, rawText: text(AI_MAX_INPUT, 1) })),
      recovery: nullable(
        object({
          version,
          updatedAt: text(100, 1),
          definitionOfDone: text(2000),
          blockerText: text(2000),
          lastContext: text(2000),
          restartHint: text(2000),
          waitingNote: text(2000),
          reviewDate: nullable(day),
          nextActionTaskId: nullable(id),
          nextActionCleared: { type: "boolean" },
        }),
      ),
      recentRecords: array(
        object({
          id,
          version,
          title: text(240, 1),
          recordType: text(40, 1),
          bodyExcerpt: text(1000),
          updatedAt: text(100, 1),
          truncated: { type: "boolean" },
        }),
        5,
      ),
      truncated: { type: "boolean" },
      personal: object(
        {
          scope: { type: "string", enum: ["project", "new_project", "todos"] },
          readAt: text(100, 1),
          candidateTaskIds: array(id, 3),
        },
        ["scope", "readAt"],
      ),
      availableMinutes: nullable({
        type: "integer",
        minimum: 1,
        maximum: 1440,
      }),
    },
    ["date", "timeZone", "project", "tasks", "source"],
  ),
});
export const aiProposalSchema = object({
  summary: text(1000, 1),
  projectName: text(120),
  outcome: text(2000),
  assumptions: array(text(400, 1), 5),
  question: nullable(text(400, 1)),
  nextAction: text(600),
  tasks: array(
    object({
      key: { type: "string", pattern: "^s[1-9][0-9]?$" },
      title: text(300, 1),
      criteria: text(1000, 1),
      estimatedMinutes: minutes,
      dependsOn: array(
        { type: "string", pattern: "^s[1-9][0-9]?$" },
        AI_MAX_TASKS,
      ),
    }),
    AI_MAX_TASKS,
  ),
  reward: nullable(object({ title: text(200, 1), condition: text(1000, 1) })),
  suggestedTaskId: nullable(id),
  references: array(
    object({
      kind: { type: "string", enum: ["recovery", "record", "task"] },
      id,
      version,
    }),
    8,
  ),
});
const { references: _references, ...legacyProposalFields } =
  aiProposalSchema.properties;
/** Older clients reject extra proposal fields, so preserve their original wire format. */
export const aiLegacyProposalSchema = object(legacyProposalFields);
/** Only personal clients request these additional hierarchy and optional-date fields. */
export const aiPersonalProposalSchema = object({
  ...aiProposalSchema.properties,
  tasks: array(
    object({
      key: { type: "string", pattern: "^s[1-9][0-9]?$" },
      title: text(300, 1),
      criteria: text(1000, 1),
      estimatedMinutes: nullable({ type: "integer", minimum: 1, maximum: 480 }),
      dependsOn: array(
        { type: "string", pattern: "^s[1-9][0-9]?$" },
        AI_MAX_TASKS,
      ),
      parentKey: nullable({ type: "string", pattern: "^s[1-9][0-9]?$" }),
      notes: text(4000),
      deadline: nullable(day),
    }),
    AI_MAX_TASKS,
  ),
});
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, fields: string[]) {
  return (
    Object.keys(value).length === fields.length &&
    fields.every((k) => Object.hasOwn(value, k))
  );
}
function validText(
  value: unknown,
  max: number,
  empty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (empty || value.trim().length > 0)
  );
}
/** Independent application validation remains mandatory even with provider JSON Schema. */
export function validateAiProposal(
  value: unknown,
  context?: AiGenerateRequest["context"],
): AiProposal {
  if (
    !plain(value) ||
    !keys(value, [
      "summary",
      "projectName",
      "outcome",
      "assumptions",
      "question",
      "nextAction",
      "tasks",
      "reward",
      "suggestedTaskId",
      ...(Object.hasOwn(value, "references") ? ["references"] : []),
    ]) ||
    !validText(value.summary, 1000) ||
    !validText(value.projectName, 120, true) ||
    !validText(value.outcome, 2000, true) ||
    !validText(value.nextAction, 600, true) ||
    !Array.isArray(value.assumptions) ||
    value.assumptions.length > 5 ||
    !value.assumptions.every((v) => validText(v, 400)) ||
    (value.question !== null && !validText(value.question, 400)) ||
    !Array.isArray(value.tasks) ||
    value.tasks.length > AI_MAX_TASKS
  )
    throw new Error("AI_INVALID_PROPOSAL");
  const tasks = value.tasks;
  for (const task of tasks) {
    if (
      !plain(task) ||
      !keys(task, [
        "key",
        "title",
        "criteria",
        "estimatedMinutes",
        "dependsOn",
        ...(Object.hasOwn(task, "parentKey") ? ["parentKey"] : []),
        ...(Object.hasOwn(task, "notes") ? ["notes"] : []),
        ...(Object.hasOwn(task, "deadline") ? ["deadline"] : []),
      ]) ||
      typeof task.key !== "string" ||
      !/^s[1-9][0-9]?$/.test(task.key) ||
      !validText(task.title, 300) ||
      !validText(task.criteria, 1000) ||
      (task.estimatedMinutes !== null &&
        (!Number.isInteger(task.estimatedMinutes) ||
          Number(task.estimatedMinutes) < 1 ||
          Number(task.estimatedMinutes) > 480)) ||
      !Array.isArray(task.dependsOn) ||
      task.dependsOn.length > AI_MAX_TASKS ||
      !task.dependsOn.every((k) => typeof k === "string") ||
      (Object.hasOwn(task, "parentKey") &&
        task.parentKey !== null &&
        (typeof task.parentKey !== "string" ||
          !/^s[1-9][0-9]?$/.test(task.parentKey))) ||
      (Object.hasOwn(task, "notes") && !validText(task.notes, 4000, true)) ||
      (Object.hasOwn(task, "deadline") &&
        task.deadline !== null &&
        (typeof task.deadline !== "string" ||
          !/^\d{4}-\d{2}-\d{2}$/.test(task.deadline) ||
          !Number.isFinite(Date.parse(task.deadline + "T12:00:00Z")) ||
          new Date(task.deadline + "T12:00:00Z").toISOString().slice(0, 10) !==
            task.deadline))
    )
      throw new Error("AI_INVALID_TASK");
  }
  const typed = tasks as unknown as AiDraftTask[];
  const byKey = new Map(typed.map((t) => [t.key, t]));
  if (byKey.size !== typed.length) throw new Error("AI_DUPLICATE_STEP");
  const parents = new Set<string>();
  for (const task of typed) {
    if (task.parentKey == null) continue;
    if (task.parentKey === task.key) throw new Error("AI_INVALID_HIERARCHY");
    const parent = byKey.get(task.parentKey);
    if (!parent || parent.parentKey != null)
      throw new Error("AI_INVALID_HIERARCHY");
    parents.add(parent.key);
  }
  for (const task of typed) {
    if (parents.has(task.key) && task.dependsOn.length > 0)
      throw new Error("AI_INVALID_DEPENDENCIES");
    if (task.dependsOn.some((dep) => parents.has(dep)))
      throw new Error("AI_INVALID_DEPENDENCIES");
  }
  const visiting = new Set<string>(),
    done = new Set<string>();
  function visit(key: string) {
    if (visiting.has(key)) throw new Error("AI_DEPENDENCY_CYCLE");
    if (done.has(key)) return;
    const task = byKey.get(key);
    if (!task) throw new Error("AI_UNKNOWN_DEPENDENCY");
    visiting.add(key);
    if (new Set(task.dependsOn).size !== task.dependsOn.length)
      throw new Error("AI_DUPLICATE_DEPENDENCY");
    task.dependsOn.forEach(visit);
    visiting.delete(key);
    done.add(key);
  }
  typed.forEach((t) => visit(t.key));
  if (
    value.reward !== null &&
    (!plain(value.reward) ||
      !keys(value.reward, ["title", "condition"]) ||
      !validText(value.reward.title, 200) ||
      !validText(value.reward.condition, 1000))
  )
    throw new Error("AI_INVALID_REWARD");
  if (value.suggestedTaskId !== null) {
    if (
      typeof value.suggestedTaskId !== "string" ||
      !new RegExp(uuidPattern).test(value.suggestedTaskId)
    )
      throw new Error("AI_UNKNOWN_SUGGESTION");
    if (context) {
      const task = context.tasks.find((t) => t.id === value.suggestedTaskId);
      if (!task || !isAiTaskReady(task, context))
        throw new Error("AI_UNREADY_SUGGESTION");
    }
  }
  if (Object.hasOwn(value, "references")) {
    if (!Array.isArray(value.references) || value.references.length > 8)
      throw Error("AI_INVALID_REFERENCE");
    const seen = new Set<string>();
    for (const item of value.references) {
      if (
        !plain(item) ||
        !keys(item, ["kind", "id", "version"]) ||
        !["recovery", "record", "task"].includes(String(item.kind)) ||
        typeof item.id !== "string" ||
        !new RegExp(uuidPattern).test(item.id) ||
        !Number.isSafeInteger(item.version) ||
        Number(item.version) < 0
      )
        throw Error("AI_INVALID_REFERENCE");
      const key = item.kind + ":" + item.id;
      if (seen.has(key)) throw Error("AI_INVALID_REFERENCE");
      seen.add(key);
      if (context) {
        const sourceVersion =
          item.kind === "recovery" && context.project?.id === item.id
            ? context.recovery?.version
            : item.kind === "record"
              ? context.recentRecords?.find((r) => r.id === item.id)?.version
              : item.kind === "task"
                ? context.tasks.find((t) => t.id === item.id)?.version
                : undefined;
        if (sourceVersion !== item.version) throw Error("AI_INVALID_REFERENCE");
      }
    }
  }
  if (
    value.question === null &&
    !typed.length &&
    value.suggestedTaskId === null
  )
    throw new Error("AI_EMPTY_PROPOSAL");
  return value as unknown as AiProposal;
}

/** Readiness is business policy, shared by tool results and final suggestion validation. */
export function isAiTaskReady(
  task: AiContextTask,
  context: AiGenerateRequest["context"],
): boolean {
  if (
    context.personal?.candidateTaskIds &&
    !context.personal.candidateTaskIds.includes(task.id)
  )
    return false;
  if (
    context.tasks.some((t) => t.parentId === task.id) ||
    !["todo", "in_progress"].includes(task.status) ||
    task.dependencies.some(
      (id) => context.tasks.find((t) => t.id === id)?.status !== "completed",
    )
  )
    return false;
  if (
    (task.plannedStart && task.plannedStart > context.date) ||
    (task.executionDate && task.executionDate > context.date)
  )
    return false;
  if (
    context.availableMinutes != null &&
    (task.estimatedMinutes == null ||
      task.estimatedMinutes > context.availableMinutes)
  )
    return false;
  return true;
}
