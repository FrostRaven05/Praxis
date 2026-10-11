import type { WorkspaceEntity } from "@praxis/storage-mobile";
export function unplannedTasks(entities: WorkspaceEntity[]) {
  const live = entities.filter((e) => !e.deleted);
  const projects = new Map(
    live.filter((e) => e.kind === "project").map((e) => [e.id, e]),
  );
  return live.filter((e) => {
    if (
      e.kind !== "task" ||
      e.data.executionDate ||
      e.data.parentId ||
      e.data.archivedAt ||
      ["completed", "cancelled"].includes(String(e.data.status))
    )
      return false;
    const project = projects.get(String(e.data.projectId ?? ""));
    return (
      !project || (project.data.status === "active" && !project.data.archivedAt)
    );
  });
}
export function sortedInboxTasks(
  tasks: WorkspaceEntity[],
  project: string,
  sort: string,
  descending: boolean,
) {
  return tasks
    .filter(
      (e) =>
        !project ||
        (project === "unassigned"
          ? !e.data.projectId
          : e.data.projectId === project),
    )
    .sort((a, b) => {
      const value =
        sort === "title"
          ? String(a.data.title).localeCompare(String(b.data.title), "zh-CN")
          : sort === "priority"
            ? (a.data.priority ? 4 - Number(a.data.priority) : 0) -
              (b.data.priority ? 4 - Number(b.data.priority) : 0)
            : a.createdAt.localeCompare(b.createdAt);
      return descending ? -value : value;
    });
}
