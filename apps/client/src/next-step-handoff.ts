import {
  terminal,
  timeDay,
  type WorkSnapshot,
  type WorkTask,
} from "@praxis/application";

export type NextStepKind =
  | "next_subtask"
  | "complete_parent"
  | "unlocked_dependency"
  | "next_project_task";

export interface NextStepHandoff {
  kind: NextStepKind;
  completedTitle: string;
  target: WorkTask;
  parentTitle?: string;
  projectName?: string;
  headline: string;
  alreadyOnToday: boolean;
}

function isUnblocked(task: WorkTask, byId: Map<string, WorkTask>): boolean {
  const deps = task.dependencies;
  if (!deps?.length) return true;
  return deps.every((depId) => {
    const pred = byId.get(depId);
    return !pred || pred.status === "completed";
  });
}

function hasOpenChild(taskId: string, tasks: readonly WorkTask[]): boolean {
  return tasks.some(
    (t) =>
      t.parentId === taskId &&
      t.status !== "completed" &&
      t.status !== "cancelled",
  );
}

function isActionableLeaf(
  task: WorkTask,
  tasks: readonly WorkTask[],
  byId: Map<string, WorkTask>,
  inactiveProjects: Set<string>,
): boolean {
  if (terminal(task) || ["waiting", "blocked"].includes(task.status))
    return false;
  if (task.projectId && inactiveProjects.has(task.projectId)) return false;
  if (hasOpenChild(task.id, tasks)) return false;
  return isUnblocked(task, byId);
}

function sortOrder(a: WorkTask, b: WorkTask): number {
  return (
    Number(b.status === "in_progress") - Number(a.status === "in_progress") ||
    a.rank - b.rank ||
    a.createdAt.localeCompare(b.createdAt) ||
    a.id.localeCompare(b.id)
  );
}

export function parentToAutoComplete(
  completedTaskId: string,
  tasks: readonly Pick<WorkTask, "id" | "parentId" | "status">[],
): string | null {
  const completed = tasks.find((t) => t.id === completedTaskId);
  if (!completed?.parentId) return null;
  const parent = tasks.find((t) => t.id === completed.parentId);
  if (!parent || parent.status === "completed" || parent.status === "cancelled") {
    return null;
  }
  const siblings = tasks.filter(
    (t) =>
      t.parentId === parent.id &&
      t.id !== completedTaskId &&
      t.status !== "cancelled",
  );
  return siblings.every((t) => t.status === "completed") ? parent.id : null;
}

/**
 * Pure next-step resolver called right after a task or subtask is completed.
 * Prioritizes: next sibling subtask -> parent completion -> newly unlocked dependent -> next ready task in project.
 */
export function computeNextStepHandoff(
  completedTaskId: string,
  snapshot: WorkSnapshot,
  todayDate: string,
  zone: string,
): NextStepHandoff | null {
  const original = snapshot.tasks.find((t) => t.id === completedTaskId);
  if (!original) return null;

  const tasks: WorkTask[] = snapshot.tasks.map((t) =>
    t.id === completedTaskId ? { ...t, status: "completed" } : t,
  );
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const projectNames = new Map(snapshot.projects.map((p) => [p.id, p.name]));
  const inactiveProjects = new Set(
    snapshot.projects
      .filter((p) => p.status !== "active" || p.archivedAt)
      .map((p) => p.id),
  );
  const scheduledToday = new Set<string>(
    snapshot.legacyPlans
      .filter((p) => p.date === todayDate)
      .map((p) => p.taskId),
  );
  const isOnToday = (task: WorkTask) =>
    scheduledToday.has(task.id) || timeDay(task.plan, zone) === todayDate;

  // 1. Next sibling subtask under the same parent
  if (original.parentId) {
    const parent = byId.get(original.parentId);
    const siblings = tasks
      .filter(
        (t) =>
          t.parentId === original.parentId &&
          t.id !== completedTaskId &&
          t.status !== "cancelled",
      )
      .sort(sortOrder);
    const nextReadySibling = siblings.find((t) =>
      isActionableLeaf(t, tasks, byId, inactiveProjects),
    );
    if (nextReadySibling) {
      const projectName = nextReadySibling.projectId
        ? projectNames.get(nextReadySibling.projectId)
        : undefined;
      return {
        kind: "next_subtask",
        completedTitle: original.title,
        target: nextReadySibling,
        ...(parent ? { parentTitle: parent.title } : {}),
        ...(projectName ? { projectName } : {}),
        headline: parent
          ? `已完成一步，继续推进「${parent.title}」的下一步`
          : "已完成一步，顺手推进下一步",
        alreadyOnToday: isOnToday(nextReadySibling),
      };
    }

    // 2. All sibling subtasks are finished -> prompt to complete parent
    const allSiblingsFinished = siblings.every(
      (t) => t.status === "completed",
    );
    if (parent && !terminal(parent) && allSiblingsFinished) {
      const projectName = parent.projectId
        ? projectNames.get(parent.projectId)
        : undefined;
      return {
        kind: "complete_parent",
        completedTitle: original.title,
        target: parent,
        ...(projectName ? { projectName } : {}),
        headline: `「${parent.title}」的全部子步骤已完成，顺手完成它吗？`,
        alreadyOnToday: isOnToday(parent),
      };
    }
  }

  // 3. Downstream task unlocked by completing this predecessor
  const unlocked = tasks
    .filter(
      (t) =>
        t.id !== completedTaskId &&
        Boolean(t.dependencies?.includes(completedTaskId)) &&
        isActionableLeaf(t, tasks, byId, inactiveProjects),
    )
    .sort(sortOrder);
  if (unlocked.length > 0) {
    const target = unlocked[0]!;
    const projectName = target.projectId
      ? projectNames.get(target.projectId)
      : undefined;
    return {
      kind: "unlocked_dependency",
      completedTitle: original.title,
      target,
      ...(projectName ? { projectName } : {}),
      headline: `前置已完成，已解锁后续任务`,
      alreadyOnToday: isOnToday(target),
    };
  }

  // 4. Next ready leaf task in the same active project
  if (original.projectId && !inactiveProjects.has(original.projectId)) {
    const candidates = tasks
      .filter(
        (t) =>
          t.id !== completedTaskId &&
          t.projectId === original.projectId &&
          isActionableLeaf(t, tasks, byId, inactiveProjects),
      )
      .sort(sortOrder);
    if (candidates.length > 0) {
      const target = candidates[0]!;
      const projectName = projectNames.get(original.projectId);
      return {
        kind: "next_project_task",
        completedTitle: original.title,
        target,
        ...(projectName ? { projectName } : {}),
        headline: projectName
          ? `继续推进「${projectName}」的下一步`
          : "继续推进项目的下一步",
        alreadyOnToday: isOnToday(target),
      };
    }
  }

  return null;
}
