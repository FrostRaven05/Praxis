import type { ProjectTask } from "./projects";
import { RetriableCommands } from "./retriable-commands";
export interface TaskNode extends ProjectTask {
  depth: number;
  hasChildren: boolean;
  leafTotal: number;
  leafDone: number;
}
export function projectTree(tasks: ProjectTask[]): TaskNode[] {
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  if (byId.size !== tasks.length) throw Error("任务层级重复");
  const children = new Map<string | null, ProjectTask[]>();
  for (const t of tasks) {
    const parent = t.parentTaskId ?? null;
    if (parent && !byId.has(parent)) throw Error("任务父节点缺失");
    const group = children.get(parent) ?? [];
    group.push(t);
    children.set(parent, group);
  }
  for (const group of children.values())
    group.sort(
      (a, b) =>
        (a.taskRank ?? 0) - (b.taskRank ?? 0) ||
        a.createdAt.localeCompare(b.createdAt),
    );
  const output: TaskNode[] = [];
  const visit = (task: ProjectTask, depth: number): TaskNode => {
    if (depth > tasks.length) throw Error("任务层级存在循环");
    const kids = children.get(task.taskId) ?? [];
    const node: TaskNode = {
      ...task,
      depth,
      hasChildren: kids.length > 0,
      leafTotal: 0,
      leafDone: 0,
    };
    output.push(node);
    if (kids.length) {
      for (const child of kids) {
        const next = visit(child, depth + 1);
        node.leafTotal += next.leafTotal;
        node.leafDone += next.leafDone;
      }
    } else {
      node.leafTotal = task.status === "cancelled" ? 0 : 1;
      node.leafDone = task.status === "completed" ? 1 : 0;
    }
    return node;
  };
  for (const root of children.get(null) ?? []) visit(root, 0);
  if (output.length !== tasks.length) throw Error("任务层级存在循环");
  return output;
}
export interface AddSubtasksCommand {
  operationId: string;
  parentTaskId: string;
  expectedVersion: number;
  confirmSummaryPlan: boolean;
  tasks: { taskId: string; title: string }[];
  occurredAt: string;
}
export interface SubtaskStorage {
  add(command: AddSubtasksCommand): Promise<void>;
}
export class Subtasks {
  private commands = new RetriableCommands<AddSubtasksCommand>();
  constructor(private storage: SubtaskStorage) {}
  async add(parent: ProjectTask, text: string, confirmSummaryPlan: boolean) {
    if (parent.status !== "todo") throw Error("请先撤销完成，再拆分子任务");
    if (parent.executionDate && !confirmSummaryPlan)
      throw Error("请确认将父任务的已有安排转换为汇总记录");
    const titles = text
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (!titles.length) throw Error("请至少填写一条子任务");
    await this.commands.execute(
      parent.taskId,
      (c) =>
        c.expectedVersion === parent.version &&
        c.confirmSummaryPlan === confirmSummaryPlan &&
        JSON.stringify(c.tasks.map((t) => t.title)) === JSON.stringify(titles),
      () => ({
        operationId: crypto.randomUUID(),
        parentTaskId: parent.taskId,
        expectedVersion: parent.version,
        confirmSummaryPlan,
        tasks: titles.map((title) => ({ taskId: crypto.randomUUID(), title })),
        occurredAt: new Date().toISOString(),
      }),
      (c) => this.storage.add(c),
    );
  }
}
