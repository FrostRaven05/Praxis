import { calendarDate } from "@praxis/application";
import {
  aiRecoveryReadSet,
  reviewBody,
  structuredReview,
  type WorkspaceEntity,
  type WorkspaceSnapshot,
} from "@praxis/storage-mobile";
import type {
  AiGenerateRequest,
  AiMode,
  AiProjectRecovery,
  AiSource,
} from "../../api/src/ai-contract";
import type { AiPlannerLaunch } from "./ai-planner-model";

type Data = Record<string, unknown>;
const recordKinds = new Set(["record", "review", "decision", "strategy"]);
const rowOf = (entity: WorkspaceEntity | undefined) =>
  entity?.data.row as Data | undefined;
const date = (value: unknown): string | null => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return null;
  const parsed = Date.parse(value + "T00:00:00Z");
  return Number.isFinite(parsed) &&
    new Date(parsed).toISOString().slice(0, 10) === value
    ? value
    : null;
};
const valueOf = (data: Data, keys: string[], fallback: unknown = "") => {
  for (const key of keys) if (data[key] !== undefined) return data[key];
  return fallback;
};
function linksFor(record: WorkspaceEntity, live: WorkspaceEntity[]) {
  const links = Array.isArray(record.data.links)
    ? [...(record.data.links as Data[])]
    : [];
  for (const targetType of ["project", "task"] as const) {
    const targetId = record.data[targetType + "Id"];
    if (typeof targetId === "string" && targetId)
      links.push({ targetType, targetId });
  }
  if (Array.isArray(record.data.projectIds))
    for (const targetId of record.data.projectIds)
      if (typeof targetId === "string" && targetId)
        links.push({ targetType: "project", targetId });
  for (const entity of live) {
    const row = rowOf(entity);
    if (
      entity.kind === "desktop_row" &&
      entity.data.table === "record_links" &&
      row?.record_id === record.id
    )
      links.push({ targetType: row.target_type, targetId: row.target_id });
  }
  return links;
}
/** A shared weekly review or an unknown/independent task link is deliberately excluded. */
export function projectExclusiveRecords(
  snapshot: WorkspaceSnapshot,
  projectId: string,
) {
  const live = snapshot.entities.filter((entity) => !entity.deleted);
  const tasks = new Map(
    snapshot.entities
      .filter((entity) => entity.kind === "task")
      .map((entity) => [entity.id, entity]),
  );
  return live
    .filter((entity) => {
      if (!recordKinds.has(entity.kind)) return false;
      const links = linksFor(entity, live);
      let linked = false;
      for (const link of links) {
        if (link.targetType === "project") {
          if (link.targetId !== projectId) return false;
          linked = true;
        } else if (link.targetType === "task") {
          const task = tasks.get(String(link.targetId));
          if (!task || task.data.projectId !== projectId) return false;
          linked = true;
        } else return false;
      }
      return linked;
    })
    .sort(
      (a, b) =>
        Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
        a.id.localeCompare(b.id),
    );
}
export function mobileAiContext(
  snapshot: WorkspaceSnapshot,
  project: WorkspaceEntity | null,
  source: AiSource | null = null,
): AiGenerateRequest["context"] {
  const live = snapshot.entities.filter((entity) => !entity.deleted);
  const timeZone = String(
    live.find((entity) => entity.kind === "settings")?.data.timeZone ??
      Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  let truncated = false;
  const excerpt = (value: unknown, max: number) => {
    const characters = Array.from(String(value ?? ""));
    if (characters.length > max) truncated = true;
    return characters.slice(0, max).join("");
  };
  if (
    project &&
    (project.deleted ||
      project.kind !== "project" ||
      project.data.status !== "active" ||
      project.data.archivedAt)
  )
    throw Error("请先恢复此项目为进行中，再生成建议。");
  const tasks = project
    ? live.filter(
        (entity) =>
          entity.kind === "task" && entity.data.projectId === project.id,
      )
    : [];
  if (tasks.length > 100)
    throw Error("此版本支持最多 100 项任务的项目，请先缩小项目范围。");
  const context: AiGenerateRequest["context"] = {
    date: calendarDate(new Date(), timeZone),
    timeZone,
    project: project
      ? {
          id: project.id,
          name: excerpt(project.data.title, 250),
          outcome: excerpt(
            project.data.outcome ?? project.data.definitionOfDone ?? "",
            2000,
          ),
          version: project.version,
          planVersion: Number(project.data.planVersion ?? 0),
        }
      : null,
    tasks: tasks.map((entity) => {
      const schedule = live.find(
        (row) =>
          row.kind === "desktop_row" &&
          row.data.table === "project_schedules" &&
          rowOf(row)?.task_id === entity.id,
      );
      const planRows = live
        .filter(
          (row) =>
            row.kind === "desktop_row" &&
            row.data.table === "daily_plan_items" &&
            rowOf(row)?.task_id === entity.id &&
            !rowOf(row)?.removed &&
            !rowOf(row)?.is_summary,
        )
        .sort((a, b) =>
          String(rowOf(b)?.created_at ?? b.updatedAt).localeCompare(
            String(rowOf(a)?.created_at ?? a.updatedAt),
          ),
        );
      const normalizedPlans = live
        .filter(
          (plan) =>
            plan.kind === "plan" &&
            Array.isArray(plan.data.taskIds) &&
            plan.data.taskIds.includes(entity.id),
        )
        .sort(
          (a, b) =>
            Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
            a.id.localeCompare(b.id),
        );
      const desktop = entity.data.desktop as Data | undefined;
      const statusReason =
        [
          entity.data.statusReason,
          desktop?.status_reason,
          entity.data.waitingReason,
          entity.data.blocker,
          entity.data.blockedReason,
          entity.data.waitingFor,
        ].find((value) => typeof value === "string" && value.trim()) ?? "";
      const plannedEstimate = rowOf(planRows[0])?.estimated_minutes;
      const defaultEstimate = valueOf(
        entity.data,
        ["estimatedMinutes"],
        desktop?.default_estimated_minutes,
      );
      const validEstimate = (value: unknown): value is number =>
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 1440;
      return {
        id: entity.id,
        title: excerpt(entity.data.title, 250),
        status:
          entity.data.waiting === true
            ? "waiting"
            : String(entity.data.status ?? "todo"),
        version: entity.version,
        dependencies: [
          ...new Set([
            ...(Array.isArray(entity.data.dependencies)
              ? entity.data.dependencies.filter(
                  (id): id is string => typeof id === "string",
                )
              : []),
            ...live
              .filter(
                (row) =>
                  row.kind === "desktop_row" &&
                  row.data.table === "task_dependencies" &&
                  rowOf(row)?.task_id === entity.id,
              )
              .map((row) => String(rowOf(row)?.predecessor_id)),
          ]),
        ],
        parentId:
          typeof entity.data.parentId === "string"
            ? entity.data.parentId
            : null,
        estimatedMinutes: validEstimate(plannedEstimate)
          ? plannedEstimate
          : validEstimate(defaultEstimate)
            ? defaultEstimate
            : null,
        completionCriteria: excerpt(entity.data.completionCriteria, 200),
        statusReason: excerpt(statusReason, 300),
        plannedStart: date(
          valueOf(
            entity.data,
            ["plannedStart"],
            rowOf(schedule!)?.start_date ?? entity.data.startDate,
          ),
        ),
        plannedEnd: date(
          valueOf(entity.data, ["plannedEnd"], rowOf(schedule!)?.end_date),
        ),
        executionDate: date(
          valueOf(
            entity.data,
            ["executionDate"],
            rowOf(planRows[0]!)?.execution_date ??
              normalizedPlans[0]?.data.date,
          ),
        ),
      };
    }),
    source,
  };
  if (project) {
    const canonical = live
      .filter(
        (entity) =>
          entity.kind === "desktop_row" &&
          entity.data.table === "project_context" &&
          rowOf(entity)?.project_id === project.id,
      )
      .sort(
        (a, b) =>
          b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
      )[0];
    const raw = canonical ? rowOf(canonical)! : {};
    const hasNormalized = [
      "definitionOfDone",
      "completionCriteria",
      "blockerText",
      "blocker",
      "lastContext",
      "restartHint",
      "recoveryNote",
      "waitingNote",
      "reviewDate",
      "nextActionId",
      "nextActionTaskId",
      "nextActionCleared",
    ].some((key) => Object.hasOwn(project.data, key));
    let recovery: AiProjectRecovery | null = null;
    if (canonical || hasNormalized) {
      const nextAction = valueOf(
        project.data,
        ["nextActionTaskId", "nextActionId"],
        raw.next_action_task_id ?? null,
      );
      recovery = {
        version:
          Number.isSafeInteger(raw.version) && Number(raw.version) >= 0
            ? Number(raw.version)
            : canonical
              ? Math.max(0, canonical.version - 1)
              : project.version,
        updatedAt: new Date(
          Math.max(
            Date.parse(project.updatedAt),
            canonical ? Date.parse(canonical.updatedAt) : 0,
          ),
        ).toISOString(),
        definitionOfDone: excerpt(
          valueOf(
            project.data,
            ["definitionOfDone", "completionCriteria"],
            raw.definition_of_done,
          ),
          1000,
        ),
        blockerText: excerpt(
          valueOf(project.data, ["blockerText", "blocker"], raw.blocker_text),
          1000,
        ),
        lastContext: excerpt(
          valueOf(project.data, ["lastContext"], raw.last_context),
          1000,
        ),
        restartHint: excerpt(
          valueOf(
            project.data,
            ["restartHint", "recoveryNote"],
            raw.restart_hint,
          ),
          1000,
        ),
        waitingNote: excerpt(
          valueOf(project.data, ["waitingNote"], raw.waiting_note),
          1000,
        ),
        reviewDate: date(
          valueOf(project.data, ["reviewDate"], raw.review_date),
        ),
        nextActionTaskId:
          typeof nextAction === "string" && nextAction ? nextAction : null,
        nextActionCleared:
          valueOf(
            project.data,
            ["nextActionCleared"],
            raw.next_action_cleared ?? false,
          ) === true ||
          valueOf(
            project.data,
            ["nextActionCleared"],
            raw.next_action_cleared ?? false,
          ) === 1,
      };
    }
    const allRecords = projectExclusiveRecords(snapshot, project.id);
    context.recovery = recovery;
    context.recentRecords = allRecords.slice(0, 5).map((record) => {
      const reviewRow = live.find(
        (entity) =>
          entity.kind === "desktop_row" &&
          entity.data.table === "weekly_reviews" &&
          rowOf(entity)?.record_id === record.id,
      );
      const rawReview = reviewRow ? rowOf(reviewRow)! : {};
      const completeCanonicalReview = [
        "period_start",
        "period_end",
        "achievements",
        "blockers",
        "stop_pause",
        "next_focus",
      ].every((key) => typeof rawReview[key] === "string");
      const structured =
        completeCanonicalReview || structuredReview(record.data)
          ? structuredReview({
              periodStart: valueOf(
                record.data,
                ["periodStart"],
                rawReview.period_start,
              ),
              periodEnd: valueOf(
                record.data,
                ["periodEnd"],
                rawReview.period_end,
              ),
              achievements: valueOf(
                record.data,
                ["achievements"],
                rawReview.achievements,
              ),
              blockers: valueOf(record.data, ["blockers"], rawReview.blockers),
              stopPause: valueOf(
                record.data,
                ["stopPause"],
                rawReview.stop_pause,
              ),
              nextFocus: valueOf(
                record.data,
                ["nextFocus"],
                rawReview.next_focus,
              ),
            })
          : null;
      const body = structured
        ? reviewBody(structured)
        : String(record.data.body ?? "");
      const title = String(record.data.title ?? "");
      const recordType = String(
        record.data.type ??
          record.data.recordType ??
          (record.kind === "record" ? "note" : record.kind),
      );
      const cut =
        Array.from(body).length > 500 ||
        Array.from(title).length > 120 ||
        Array.from(recordType).length > 20;
      return {
        id: record.id,
        version: record.version,
        title: excerpt(title, 120),
        recordType: excerpt(recordType, 20),
        bodyExcerpt: excerpt(body, 500),
        updatedAt: record.updatedAt,
        truncated: cut,
      };
    });
    if (allRecords.length > 5) truncated = true;
    context.truncated = truncated;
  }
  return context;
}
export function mobileAiLaunch(
  snapshot: WorkspaceSnapshot,
  project: WorkspaceEntity,
  mode: AiMode,
  input: string,
): AiPlannerLaunch {
  const localRecoveryReadSet = aiRecoveryReadSet(snapshot, project.id);
  if (localRecoveryReadSet.entities.length > 10000)
    throw Error("此项目关联资料过多，请先缩小项目范围后再使用规划助手。");
  return {
    mode,
    input,
    context: mobileAiContext(snapshot, project),
    localRecoveryReadSet,
  };
}
