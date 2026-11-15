export interface CurrentSubtaskRef {
  id: string;
  title: string;
  parentId: string | null;
  status: string;
  rank: number;
  createdAt: string;
}

/** 列表上的当前目标：优先进行中的子任务，否则按顺序取第一条未完成的。 */
export function currentSubtask<T extends CurrentSubtaskRef>(
  tasks: readonly T[],
  parentId: string,
): T | null {
  const open = tasks
    .filter((task) => task.parentId === parentId && task.status !== "cancelled")
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        a.createdAt.localeCompare(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  return (
    open.find((task) => task.status === "in_progress") ??
    open.find((task) => task.status !== "completed") ??
    null
  );
}

/** The task that can be placed on today: itself when it has no open child, otherwise the current leaf. */
export function todayTarget<T extends CurrentSubtaskRef>(
  tasks: readonly T[],
  task: T,
): T | null {
  if (task.status === "completed" || task.status === "cancelled") return null;
  const seen = new Set<string>();
  let current = task;
  while (!seen.has(current.id)) {
    seen.add(current.id);
    const child = currentSubtask(tasks, current.id);
    if (!child) return current;
    current = child;
  }
  return null;
}
