import { useState } from "react";
import {
  calendarDate,
  daysBetween,
  shiftDate,
  scheduleEntries,
  previewSchedule,
  projectTree,
  type Project,
  type ProjectTask,
  type ScheduleEntry,
} from "@praxis/application";
import { workspace } from "./storage";
type Draft = {
  taskId: string;
  entries: ScheduleEntry[];
  version: number;
  start: string;
  end: string;
  dependencies: string[];
};
type Preview = {
  before: ScheduleEntry[];
  after: ScheduleEntry[];
  version: number;
};
export function GanttView({
  project,
  tasks,
  onSaved,
  onDay,
}: {
  project: Project;
  tasks: ProjectTask[];
  onSaved: () => Promise<unknown>;
  onDay: (date: string) => void;
}) {
  const today = calendarDate(
    new Date(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const tree = projectTree(tasks),
    entries = scheduleEntries(tasks);
  const [anchor, setAnchor] = useState(
      entries.find((e) => e.start)?.start ?? today,
    ),
    [draft, setDraft] = useState<Draft | null>(null),
    [preview, setPreview] = useState<Preview | null>(null),
    [undo, setUndo] = useState<Preview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const [drag, setDrag] = useState<{ id: string; x: number } | null>(null);
  const days = 42,
    unit = 32,
    label = 210,
    rowHeight = 46;
  function edit(id: string) {
    if (busy || preview) return;
    const e = entries.find((e) => e.taskId === id);
    if (!e) return;
    setDraft({
      taskId: id,
      entries,
      version: project.planVersion ?? 0,
      start: e.start ?? "",
      end: e.end ?? "",
      dependencies: [...e.dependencies],
    });
    setPreview(null);
    setError("");
  }
  function prepare(
    before: ScheduleEntry[],
    change: ScheduleEntry,
    version: number,
  ) {
    setError("");
    try {
      setPreview({ before, after: previewSchedule(before, change), version });
    } catch (e) {
      setError(String(e));
    }
  }
  async function apply(p: Preview, isUndo = false) {
    setBusy(true);
    setError("");
    try {
      await workspace.execute({
        kind: "schedule",
        projectId: project.id,
        expectedPlanVersion: p.version,
        entries: p.after,
      });
      setUndo(
        isUndo
          ? null
          : { before: p.after, after: p.before, version: p.version + 1 },
      );
      await onSaved();
      setDraft(null);
      setPreview(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function bounds(task: (typeof tree)[number]): {
    start: string | null;
    end: string | null;
  } {
    const e = entries.find((e) => e.taskId === task.taskId);
    if (!task.hasChildren)
      return { start: e?.start ?? null, end: e?.end ?? null };
    const ids = new Set([task.taskId]);
    for (const t of tree)
      if (t.parentTaskId && ids.has(t.parentTaskId)) ids.add(t.taskId);
    const scheduled = entries.filter((e) => ids.has(e.taskId) && e.start);
    return {
      start: scheduled.map((e) => e.start!).sort()[0] ?? null,
      end:
        scheduled
          .map((e) => e.end!)
          .sort()
          .at(-1) ?? null,
    };
  }
  const changed =
    preview?.after.filter(
      (e, i) => JSON.stringify(e) !== JSON.stringify(preview.before[i]),
    ) ?? [];
  const deviations = (preview?.after ?? entries).filter((e) => {
    const t = tasks.find((t) => t.taskId === e.taskId);
    return (
      t?.executionDate &&
      e.start &&
      (t.executionDate < e.start || t.executionDate > e.end!)
    );
  });
  return (
    <section className="gantt-view" aria-label="项目甘特图">
      <p className="task-meta">
        项目计划与每日安排分别保存。拖动任务条或点按任务编辑日期；前置依赖为完成后开始，顺延方案确认后生效。
      </p>
      <div className="gantt-toolbar">
        <button onClick={() => setAnchor(shiftDate(anchor, -14))}>
          前两周
        </button>
        <button onClick={() => setAnchor(today)}>定位今日</button>
        <button onClick={() => setAnchor(shiftDate(anchor, 14))}>后两周</button>
        <label>
          时间轴起日
          <input
            type="date"
            value={anchor}
            onChange={(e) => {
              if (e.target.value) setAnchor(e.target.value);
            }}
          />
        </label>
        {undo && (
          <button disabled={busy} onClick={() => void apply(undo, true)}>
            撤销上次排期
          </button>
        )}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}{" "}
          <button
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setDraft(null);
              void onSaved();
            }}
          >
            重新读取计划
          </button>
        </p>
      )}
      {draft && (
        <form
          aria-label="编辑甘特排期"
          className="workspace-editor"
          onSubmit={(e) => {
            e.preventDefault();
            prepare(
              draft.entries,
              {
                taskId: draft.taskId,
                start: draft.start || null,
                end: draft.end || null,
                dependencies: draft.dependencies,
              },
              draft.version,
            );
          }}
        >
          <fieldset disabled={busy || !!preview}>
            <h3>{tasks.find((t) => t.taskId === draft.taskId)?.title}</h3>
            <div className="date-fields">
              <label>
                计划开始日
                <input
                  type="date"
                  value={draft.start}
                  onChange={(e) =>
                    setDraft({ ...draft, start: e.target.value })
                  }
                />
              </label>
              <label>
                计划结束日
                <input
                  type="date"
                  value={draft.end}
                  onChange={(e) => setDraft({ ...draft, end: e.target.value })}
                />
              </label>
            </div>
            <button
              type="button"
              onClick={() => setDraft({ ...draft, start: "", end: "" })}
            >
              清除计划日期
            </button>
            <fieldset className="dependency-options">
              <legend>前置任务（完成后开始）</legend>
              {draft.entries
                .filter((e) => e.taskId !== draft.taskId)
                .map((e) => (
                  <label key={e.taskId}>
                    <input
                      type="checkbox"
                      checked={draft.dependencies.includes(e.taskId)}
                      onChange={(event) =>
                        setDraft({
                          ...draft,
                          dependencies: event.target.checked
                            ? [...draft.dependencies, e.taskId]
                            : draft.dependencies.filter(
                                (id) => id !== e.taskId,
                              ),
                        })
                      }
                    />
                    {tasks.find((t) => t.taskId === e.taskId)?.title}
                  </label>
                ))}
            </fieldset>
            <button>预览排期调整</button>{" "}
            <button
              type="button"
              onClick={() => {
                setDraft(null);
                setError("");
              }}
            >
              取消编辑
            </button>
          </fieldset>
        </form>
      )}
      {preview && (
        <section className="schedule-preview" aria-label="排期调整预览">
          <h3>确认排期调整 · {changed.length} 项</h3>
          <ul>
            {changed.map((e) => {
              const before = preview.before.find((b) => b.taskId === e.taskId)!;
              return (
                <li key={e.taskId}>
                  <strong>
                    {tasks.find((t) => t.taskId === e.taskId)?.title}
                  </strong>
                  ：{before.start ?? "未排期"} ～ {before.end ?? "—"} →{" "}
                  {e.start ?? "未排期"} ～ {e.end ?? "—"}
                  {JSON.stringify(before.dependencies) !==
                    JSON.stringify(e.dependencies) && " · 前置依赖已调整"}
                </li>
              );
            })}
          </ul>
          <p>已有每日安排不会随此方案移动。</p>
          <button disabled={busy} onClick={() => void apply(preview)}>
            确认应用排期
          </button>{" "}
          <button disabled={busy} onClick={() => setPreview(null)}>
            取消预览
          </button>
        </section>
      )}
      {deviations.length > 0 && (
        <aside className="schedule-warning">
          <strong>每日安排超出项目计划窗口</strong>
          {deviations.map((e) => {
            const t = tasks.find((t) => t.taskId === e.taskId)!;
            return (
              <p key={t.taskId}>
                {t.title} · {t.executionDate}{" "}
                <button
                  onClick={() => onDay(t.completionDate ?? t.executionDate!)}
                >
                  查看安排
                </button>
              </p>
            );
          })}
        </aside>
      )}
      <div className="gantt-scroll">
        <svg
          role="img"
          aria-label="按日项目排期与依赖"
          width={label + days * unit}
          height={Math.max(130, tree.length * rowHeight + 50)}
        >
          <defs>
            <marker
              id="dependency-arrow"
              viewBox="0 0 10 10"
              refX="9"
              refY="5"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-secondary)" />
            </marker>
          </defs>
          {Array.from({ length: days }, (_, i) => {
            const d = shiftDate(anchor, i);
            return (
              <g key={d}>
                <line
                  x1={label + i * unit}
                  x2={label + i * unit}
                  y1={30}
                  y2={tree.length * rowHeight + 50}
                  stroke="var(--line)"
                />
                <text
                  x={label + i * unit + 4}
                  y={20}
                  fontSize={11}
                  fill="var(--text-secondary)"
                >
                  {d.slice(5)}
                </text>
              </g>
            );
          })}
          {daysBetween(anchor, today) >= 0 &&
            daysBetween(anchor, today) < days && (
              <g>
                <line
                  x1={label + daysBetween(anchor, today) * unit}
                  x2={label + daysBetween(anchor, today) * unit}
                  y1={27}
                  y2={tree.length * rowHeight + 50}
                  stroke="var(--primary)"
                  strokeWidth={2}
                />
                <title>今日 {today}</title>
              </g>
            )}
          {tree.map((t, i) => {
            const e = bounds(t);
            const start = e.start ? daysBetween(anchor, e.start) : 0,
              end = e.end ? daysBetween(anchor, e.end) : 0;
            const visible = e.start && end >= 0 && start < days;
            return (
              <g key={t.taskId}>
                <line
                  x1={0}
                  x2={label + days * unit}
                  y1={i * rowHeight + 76}
                  y2={i * rowHeight + 76}
                  stroke="var(--line)"
                />
                <text
                  x={8 + Math.min(t.depth, 5) * 10}
                  y={i * rowHeight + 56}
                  fontSize={12}
                  fill="var(--text-primary)"
                  onClick={() => !t.hasChildren && edit(t.taskId)}
                  style={{ cursor: t.hasChildren ? "default" : "pointer" }}
                >
                  {t.title.length > 20 ? t.title.slice(0, 20) + "…" : t.title}
                  <title>{t.title}</title>
                </text>
                {visible && (
                  <rect
                    data-task-id={t.taskId}
                    role={t.hasChildren ? undefined : "button"}
                    aria-label={"编辑排期：" + t.title}
                    tabIndex={t.hasChildren ? -1 : 0}
                    x={label + Math.max(0, start) * unit + 2}
                    y={i * rowHeight + 38}
                    width={
                      (Math.min(days - 1, end) - Math.max(0, start) + 1) *
                        unit -
                      4
                    }
                    height={t.hasChildren ? 12 : 24}
                    rx={4}
                    fill={
                      t.hasChildren
                        ? "var(--text-secondary)"
                        : t.status === "completed"
                          ? "var(--success-text)"
                          : "var(--primary)"
                    }
                    style={{
                      cursor: t.hasChildren ? "default" : "grab",
                      touchAction: "none",
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !t.hasChildren)
                        edit(t.taskId);
                    }}
                    onPointerDown={(event) => {
                      if (t.hasChildren || busy || preview) return;
                      event.currentTarget.setPointerCapture(event.pointerId);
                      setDrag({ id: t.taskId, x: event.clientX });
                    }}
                    onPointerUp={(event) => {
                      if (!drag || drag.id !== t.taskId) return;
                      const delta = Math.round((event.clientX - drag.x) / unit);
                      setDrag(null);
                      const current = entries.find(
                        (e) => e.taskId === t.taskId,
                      )!;
                      if (delta && current.start) {
                        setDraft(null);
                        prepare(
                          entries,
                          {
                            ...current,
                            start: shiftDate(current.start, delta),
                            end: shiftDate(current.end!, delta),
                          },
                          project.planVersion ?? 0,
                        );
                      } else edit(t.taskId);
                    }}
                  >
                    <title>
                      {t.title}：{e.start} ～ {e.end}
                    </title>
                  </rect>
                )}
              </g>
            );
          })}
          {entries.flatMap((e) =>
            e.dependencies.map((id) => {
              const from = entries.find((p) => p.taskId === id),
                a = tree.findIndex((t) => t.taskId === id),
                b = tree.findIndex((t) => t.taskId === e.taskId);
              if (!from?.end || !e.start) return null;
              const x1 = label + (daysBetween(anchor, from.end) + 1) * unit,
                x2 = label + daysBetween(anchor, e.start) * unit,
                y1 = a * rowHeight + 50,
                y2 = b * rowHeight + 50;
              if (
                x1 < label ||
                x2 < label ||
                x1 > label + days * unit ||
                x2 > label + days * unit
              )
                return null;
              return (
                <path
                  key={e.taskId + id}
                  d={`M ${x1} ${y1} H ${x1 + 8} V ${y2} H ${x2}`}
                  fill="none"
                  stroke="var(--text-secondary)"
                  markerEnd="url(#dependency-arrow)"
                  pointerEvents="none"
                />
              );
            }),
          )}
        </svg>
      </div>
      <div className="gantt-task-picker">
        <h3>未排期（{entries.filter((e) => !e.start).length}）</h3>
        {entries
          .filter((e) => !e.start)
          .map((e) => (
            <button
              key={e.taskId}
              disabled={busy || !!preview}
              onClick={() => edit(e.taskId)}
            >
              {tasks.find((t) => t.taskId === e.taskId)?.title}
            </button>
          ))}
        <details>
          <summary>编辑任意叶子任务的日期与依赖</summary>
          {entries.map((e) => (
            <button
              key={e.taskId}
              disabled={busy || !!preview}
              onClick={() => edit(e.taskId)}
            >
              {tasks.find((t) => t.taskId === e.taskId)?.title}
            </button>
          ))}
        </details>
      </div>
    </section>
  );
}
