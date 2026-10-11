import type { WorkspaceEntity } from "@praxis/storage-mobile";
export interface SearchFilter {
  query: string;
  kind: string;
  status: string;
  projectId: string;
  mode: string;
  includeArchived: boolean;
  priority: string;
  due: string;
  sort: string;
  group: string;
  preset: string;
}
export const emptyFilter: SearchFilter = {
  query: "",
  kind: "",
  status: "",
  projectId: "",
  mode: "and",
  includeArchived: false,
  priority: "",
  due: "",
  sort: "updated",
  group: "kind",
  preset: "",
};
export const text = (v: unknown) => (typeof v === "string" ? v : "");
export const entityTitle = (e: WorkspaceEntity) =>
  text(e.data.title) || "未命名";
export function searchEntities(
  entities: WorkspaceEntity[],
  filter: SearchFilter,
  today: string,
) {
  const live = entities.filter((e) => !e.deleted),
    end = new Date(today + "T12:00:00Z");
  end.setUTCDate(end.getUTCDate() + 6);
  const weekEnd = end.toISOString().slice(0, 10);
  return live
    .filter((e) => {
      if (
        ![
          "task",
          "project",
          "record",
          "habit",
          "strategy",
          "decision",
          "review",
        ].includes(e.kind) ||
        (filter.kind && e.kind !== filter.kind)
      )
        return false;
      if (
        !filter.includeArchived &&
        (!!e.data.archivedAt ||
          live.some((p) => p.id === e.data.projectId && !!p.data.archivedAt))
      )
        return false;
      const active =
        e.kind === "task" &&
        !["completed", "cancelled"].includes(text(e.data.status));
      if (
        filter.preset === "unplanned" &&
        (!active || e.data.projectId || e.data.executionDate)
      )
        return false;
      if (
        filter.preset === "focus" &&
        (!active || ![1, 2].includes(Number(e.data.priority)))
      )
        return false;
      if (
        filter.preset === "small" &&
        (!active ||
          !Number(e.data.estimatedMinutes) ||
          Number(e.data.estimatedMinutes) > 15)
      )
        return false;
      if (filter.preset === "waiting" && (!active || e.data.waiting !== true))
        return false;
      if (
        filter.preset === "week" &&
        (!active ||
          !e.data.dueDate ||
          text(e.data.dueDate) < today ||
          text(e.data.dueDate) > weekEnd)
      )
        return false;
      const checks: boolean[] = [];
      if (filter.query)
        checks.push(
          `${entityTitle(e)} ${text(e.data.body)} ${text(e.data.notes)}`
            .toLocaleLowerCase()
            .includes(filter.query.toLocaleLowerCase()),
        );
      if (filter.status) checks.push(e.data.status === filter.status);
      if (filter.projectId)
        checks.push(
          e.data.projectId === filter.projectId || e.id === filter.projectId,
        );
      if (filter.priority)
        checks.push(
          e.kind === "task" &&
            Number(e.data.priority) === Number(filter.priority),
        );
      if (filter.due)
        checks.push(
          !!e.data.dueDate &&
            (filter.due === "overdue"
              ? text(e.data.dueDate) < today
              : filter.due === "today"
                ? e.data.dueDate === today
                : text(e.data.dueDate) >= today &&
                  text(e.data.dueDate) <= weekEnd),
        );
      return (
        !checks.length ||
        (filter.mode === "or" ? checks.some(Boolean) : checks.every(Boolean))
      );
    })
    .sort((a, b) =>
      filter.sort === "title"
        ? entityTitle(a).localeCompare(entityTitle(b), "zh")
        : filter.sort === "priority"
          ? Number(a.data.priority || 4) - Number(b.data.priority || 4)
          : filter.sort === "due"
            ? (text(a.data.dueDate) || "9999").localeCompare(
                text(b.data.dueDate) || "9999",
              )
            : b.updatedAt.localeCompare(a.updatedAt),
    );
}
export function projectEvidence(
  project: WorkspaceEntity,
  entities: WorkspaceEntity[],
  today: string,
) {
  const tasks = entities.filter(
    (e) =>
      !e.deleted &&
      e.kind === "task" &&
      e.data.projectId === project.id &&
      !["completed", "cancelled"].includes(text(e.data.status)),
  );
  const evidence = entities.filter(
    (e) =>
      !e.deleted &&
      e.data.projectId === project.id &&
      (["record", "review", "strategy", "decision"].includes(e.kind) ||
        (e.kind === "task" && !!e.data.completedAt)),
  );
  const latest = evidence
    .map((e) => text(e.data.completedAt) || e.updatedAt)
    .sort()
    .at(-1);
  const staleBefore = new Date(today + "T12:00:00Z");
  staleBefore.setUTCDate(staleBefore.getUTCDate() - 14);
  return {
    missingNext: !tasks.some((t) => t.id === project.data.nextActionId),
    overdue: tasks.filter((t) => t.data.dueDate && text(t.data.dueDate) < today)
      .length,
    waiting: tasks.filter((t) => t.data.waiting === true).length,
    reviewDue:
      !!project.data.reviewDate && text(project.data.reviewDate) <= today,
    stagnant: !latest || latest < staleBefore.toISOString(),
    latest,
  };
}
export function historySummary(payload: unknown): string[] {
  try {
    const p = typeof payload === "string" ? JSON.parse(payload) : payload;
    if (!p || typeof p !== "object") return ["保存本机内容"];
    if (Array.isArray(p.changes))
      return p.changes.map(
        (c: {
          kind?: string;
          expectedVersion?: number | null;
          deleted?: boolean;
          data?: Record<string, unknown>;
        }) =>
          `${c.deleted ? "移入回收站" : c.expectedVersion == null ? "创建" : "更新"} ${kindLabel(c.kind || "")}：${text(c.data?.title) || text(c.data?.date) || "内容"}`,
      );
    if (p.format === "praxis-mobile-workspace") return ["导入工作空间"];
    return ["保存或迁移本机记录"];
  } catch {
    return ["本机历史记录"];
  }
}
export function kindLabel(kind: string) {
  return (
    (
      {
        task: "任务",
        project: "项目",
        record: "记录",
        habit: "习惯",
        habit_check: "习惯打卡",
        recurrence: "重复规则",
        review: "回顾",
        strategy: "策略",
        decision: "决策",
        view: "视图",
        focus: "专注",
        settings: "设置",
        capture: "收集项",
      } as Record<string, string>
    )[kind] || "内容"
  );
}
