import { RetriableCommands } from "./retriable-commands";
import { validCalendarDate } from "./edit-task";
export interface ProjectFields {
  name: string;
  outcome: string;
  targetDate: string | null;
  priority: number;
}
export interface Project extends ProjectFields {
  id: string;
  version: number;
}
export interface ProjectTask {
  taskId: string;
  title: string;
  version: number;
  createdAt: string;
  status: string;
  executionDate: string | null;
  completionDate: string | null;
}
export interface SaveProjectCommand extends ProjectFields {
  operationId: string;
  projectId: string;
  expectedVersion: number | null;
  occurredAt: string;
}
export interface AddProjectTasksCommand {
  operationId: string;
  projectId: string;
  tasks: { taskId: string; title: string }[];
  occurredAt: string;
}
export interface AssignProjectCommand {
  operationId: string;
  projectId: string;
  taskId: string;
  expectedVersion: number;
  occurredAt: string;
}
export interface ProjectStorage {
  listProjects(): Promise<Project[]>;
  projectTasks(projectId: string): Promise<ProjectTask[]>;
  saveProject(command: SaveProjectCommand): Promise<void>;
  addProjectTasks(command: AddProjectTasksCommand): Promise<void>;
  assignProject(command: AssignProjectCommand): Promise<void>;
}
export class Projects {
  private saves = new RetriableCommands<SaveProjectCommand>();
  private batches = new RetriableCommands<AddProjectTasksCommand>();
  private assignments = new RetriableCommands<AssignProjectCommand>();
  constructor(private storage: ProjectStorage) {}
  async save(base: Project | null, fields: ProjectFields): Promise<string> {
    const normalized = {
      ...fields,
      name: fields.name.trim(),
      outcome: fields.outcome.trim(),
    };
    if (!normalized.name) throw new Error("请填写项目名称");
    if (fields.targetDate && !validCalendarDate(fields.targetDate))
      throw new Error("目标日期无效");
    if (![0, 1, 2].includes(fields.priority)) throw new Error("项目优先级无效");
    const result = await this.saves.execute(
      base?.id ?? "new",
      (c) =>
        c.name === normalized.name &&
        c.outcome === normalized.outcome &&
        c.targetDate === normalized.targetDate &&
        c.priority === normalized.priority &&
        c.expectedVersion === (base?.version ?? null),
      () => ({
        ...normalized,
        operationId: crypto.randomUUID(),
        projectId: base?.id ?? crypto.randomUUID(),
        expectedVersion: base?.version ?? null,
        occurredAt: new Date().toISOString(),
      }),
      (c) => this.storage.saveProject(c),
    );
    return result.command.projectId;
  }
  async add(projectId: string, text: string) {
    const titles = text
      .split(/\r?\n/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!titles.length) throw new Error("请至少填写一条任务，每行一条");
    await this.batches.execute(
      projectId,
      (c) =>
        JSON.stringify(c.tasks.map((t) => t.title)) === JSON.stringify(titles),
      () => ({
        operationId: crypto.randomUUID(),
        projectId,
        tasks: titles.map((title) => ({ taskId: crypto.randomUUID(), title })),
        occurredAt: new Date().toISOString(),
      }),
      (c) => this.storage.addProjectTasks(c),
    );
  }
  async assign(task: { taskId: string; version?: number }, projectId: string) {
    if (!projectId) throw new Error("请选择项目");
    await this.assignments.execute(
      task.taskId,
      (c) =>
        c.projectId === projectId && c.expectedVersion === (task.version ?? 0),
      () => ({
        operationId: crypto.randomUUID(),
        projectId,
        taskId: task.taskId,
        expectedVersion: task.version ?? 0,
        occurredAt: new Date().toISOString(),
      }),
      (c) => this.storage.assignProject(c),
    );
  }
}
