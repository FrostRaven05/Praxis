import type { Project, SaveProjectCommand } from "./projects";
import type { WorkSnapshot } from "./productivity";
import { validCalendarDate } from "./edit-task";
import { personalTaskQuery } from "./personal-tasks";

export interface PersonalProjectFields {
  name: string;
  outcome: string;
  targetDate: string | null;
}
export class PersonalProjectRejectedError extends Error {}

/** One editor owns one immutable attempt until its receipt is known. */
export function createPersonalProjectSave(
  base: Project | null,
  port: {
    scope(): Promise<string>;
    save(command: SaveProjectCommand): Promise<void>;
    rejected(error: unknown): boolean;
  },
) {
  // Capture identity when the editor opens, before the user starts typing.
  const originalScope = port.scope().then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  let pending: SaveProjectCommand | null = null;
  let active = false;
  let savedId: string | null = null;
  return async (fields: PersonalProjectFields): Promise<string> => {
    if (savedId) return savedId;
    if (active) throw new PersonalProjectRejectedError("正在保存项目");
    const normalized = {
      ...fields,
      name: fields.name.trim(),
      outcome: fields.outcome.trim(),
    };
    if (!normalized.name)
      throw new PersonalProjectRejectedError("请填写项目名称");
    if (normalized.targetDate && !validCalendarDate(normalized.targetDate))
      throw new PersonalProjectRejectedError("目标日期无效");
    if (
      pending &&
      (pending.name !== normalized.name ||
        pending.outcome !== normalized.outcome ||
        pending.targetDate !== normalized.targetDate)
    )
      throw new PersonalProjectRejectedError(
        "上次保存结果未确认，请先重试原内容",
      );
    active = true;
    try {
      const scope = await originalScope;
      if ("error" in scope)
        throw new PersonalProjectRejectedError(
          "无法确认账号，请关闭后重新打开项目表单",
        );
      if ((await port.scope()) !== scope.value) {
        const message = "账号或工作空间已变化，请返回原账号和工作空间后重试";
        // A prior unknown write must remain locked until its original receipt is resolved.
        throw pending
          ? new Error(message)
          : new PersonalProjectRejectedError(message);
      }
      pending ??= {
        ...normalized,
        priority: base?.priority ?? 1,
        operationId: crypto.randomUUID(),
        projectId: base?.id ?? crypto.randomUUID(),
        expectedVersion: base?.version ?? null,
        occurredAt: new Date().toISOString(),
      };
      await port.save(pending);
      savedId = pending.projectId;
      pending = null;
      return savedId;
    } catch (error) {
      if (port.rejected(error)) {
        pending = null;
        throw new PersonalProjectRejectedError(
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    } finally {
      active = false;
    }
  };
}

/** All project cards use the personal query's leaf/date rules. Bad legacy trees stay visible. */
export function personalProjectList(
  work: WorkSnapshot,
  now = new Date(),
  zone = "UTC",
) {
  let query: ReturnType<typeof personalTaskQuery> | null = null;
  let readError = "";
  try {
    query = personalTaskQuery(work, now, zone);
  } catch (error) {
    readError = error instanceof Error ? error.message : String(error);
  }
  return work.projects
    .map((project) => {
      try {
        if (!query) throw Error(readError);
        return { project, progress: query.progress(project.id), error: "" };
      } catch (error) {
        return {
          project,
          progress: null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })
    .sort((a, b) => {
      const at = (p: typeof a.project) => {
        return (
          [p.updatedAt, p.createdAt]
            .map((value) => Date.parse(value ?? ""))
            .find(Number.isFinite) ?? 0
        );
      };
      return (
        at(b.project) - at(a.project) ||
        a.project.id.localeCompare(b.project.id)
      );
    });
}
