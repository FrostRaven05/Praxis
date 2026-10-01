import { useEffect, useId, useRef, useState } from "react";
import {
  calendarDate,
  daysBetween,
  shiftDate,
  scheduleEntries,
  previewSchedule,
  projectTree,
  validCalendarDate,
  type Project,
  type ProjectTask,
  type ScheduleEntry,
} from "@praxis/application";
import { TaskActionMenu } from "./TaskActionMenu";
import { workspace } from "./storage";
import { DatePicker } from "./DatePicker";

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
const sameEntry = (a: ScheduleEntry | undefined, b: ScheduleEntry) =>
  !!a &&
  a.start === b.start &&
  a.end === b.end &&
  JSON.stringify([...a.dependencies].sort()) ===
    JSON.stringify([...b.dependencies].sort());
const changedEntries = (p: Preview) =>
  p.after.filter(
    (entry) =>
      !sameEntry(
        p.before.find((before) => before.taskId === entry.taskId),
        entry,
      ),
  );
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const shortDate = (date: string) =>
  `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

export function GanttView({
  project,
  tasks,
  onSaved,
  onDay,
  showCancelled = false,
  onBusyChange,
  disabled = false,
}: {
  project: Project;
  tasks: ProjectTask[];
  onSaved: () => Promise<unknown>;
  onDay: (date: string) => void;
  showCancelled?: boolean;
  onBusyChange?: (busy: boolean) => void;
  disabled?: boolean;
}) {
  const today = calendarDate(
    new Date(),
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const allTree = projectTree(tasks);
  // Hidden tasks remain in the command so dependency validation stays complete.
  const tree = allTree.filter(
    (task) => showCancelled || task.status !== "cancelled",
  );
  const entries = scheduleEntries(tasks);
  const [anchor, setAnchor] = useState(
    entries.find((entry) => entry.start)?.start ?? today,
  );
  const [draft, setDraft] = useState<Draft | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pendingProposal, setPendingProposal] = useState<Preview | null>(null);
  const pending = useRef<Preview | null>(null);
  const committed = useRef(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [error, setError] = useState("");
  const [compare, setCompare] = useState(false);
  const [drag, setDrag] = useState<{
    id: string;
    x: number;
    entries: ScheduleEntry[];
    version: number;
  } | null>(null);
  const [scale, setScale] = useState<"day" | "week">("day");
  const editorInput = useRef<HTMLButtonElement>(null);
  const graphId = useId().replace(/:/g, "");
  const days = scale === "day" ? 42 : 84;
  const unit = scale === "day" ? 44 : 18;
  const label = 210,
    rowHeight = 46;
  const viewportEnd = shiftDate(anchor, days - 1);
  const step = scale === "day" ? 14 : 28;
  const locked = busy || disabled;
  const active = busy || !!draft || !!preview || !!pendingProposal;
  const editing = locked || active;
  useEffect(() => {
    onBusyChange?.(active);
    return () => onBusyChange?.(false);
  }, [active, onBusyChange]);
  useEffect(() => {
    if (draft && !preview) editorInput.current?.focus();
  }, [draft?.taskId, !!preview]);

  function edit(id: string) {
    if (editing || saving.current || pending.current) return;
    const entry = entries.find((item) => item.taskId === id);
    if (!entry) return;
    setDraft({
      taskId: id,
      entries,
      version: project.planVersion ?? 0,
      start: entry.start ?? "",
      end: entry.end ?? "",
      dependencies: [...entry.dependencies],
    });
    setPreview(null);
    setError("");
  }
  async function apply(p: Preview) {
    if (locked || saving.current || (pending.current && pending.current !== p))
      return;
    if (!pending.current) {
      pending.current = p;
      committed.current = false;
      setPendingProposal(p);
    }
    saving.current = true;
    setBusy(true);
    setError("");
    try {
      if (!committed.current) {
        await workspace.execute({
          kind: "schedule",
          projectId: project.id,
          expectedPlanVersion: p.version,
          entries: p.after,
        });
        committed.current = true;
      }
      await onSaved();
      pending.current = null;
      committed.current = false;
      setPendingProposal(null);
      setDraft(null);
      setPreview(null);
    } catch (e) {
      setError(errorText(e));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  async function prepare(
    before: ScheduleEntry[],
    change: ScheduleEntry,
    version: number,
  ) {
    if (locked || saving.current || pending.current) return;
    setError("");
    try {
      const p = { before, after: previewSchedule(before, change), version };
      const changed = changedEntries(p);
      if (!changed.length) {
        setDraft(null);
        setPreview(null);
      } else if (
        changed.length === 1 &&
        changed[0]?.taskId === change.taskId &&
        sameEntry(
          p.after.find((entry) => entry.taskId === change.taskId),
          change,
        )
      )
        await apply(p);
      // Confirm every dependency-induced shift, including a changed requested date.
      else setPreview(p);
    } catch (e) {
      setError(errorText(e));
    }
  }
  function bounds(task: (typeof tree)[number]): {
    start: string | null;
    end: string | null;
  } {
    const entry = entries.find((item) => item.taskId === task.taskId);
    if (!task.hasChildren)
      return { start: entry?.start ?? null, end: entry?.end ?? null };
    const ids = new Set([task.taskId]);
    for (const child of allTree)
      if (child.parentTaskId && ids.has(child.parentTaskId))
        ids.add(child.taskId);
    const scheduled = entries.filter(
      (item) => ids.has(item.taskId) && item.start,
    );
    return {
      start: scheduled.map((item) => item.start!).sort()[0] ?? null,
      end:
        scheduled
          .map((item) => item.end!)
          .sort()
          .at(-1) ?? null,
    };
  }
  const changed = preview ? changedEntries(preview) : [];
  const deviations = (preview?.after ?? entries).filter((entry) => {
    const task = tasks.find((item) => item.taskId === entry.taskId);
    return (
      task?.executionDate &&
      entry.start &&
      (task.executionDate < entry.start || task.executionDate > entry.end!)
    );
  });
  return (
    <section
      className="gantt-view compact-gantt"
      aria-label="项目甘特图"
      aria-busy={busy}
    >
      <div className="gantt-toolbar">
        <div className="gantt-navigation">
          <button
            type="button"
            aria-label="查看更早日期"
            title="查看更早日期"
            disabled={!validCalendarDate(shiftDate(anchor, -step))}
            onClick={() => setAnchor(shiftDate(anchor, -step))}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m14 6-6 6 6 6" />
            </svg>
          </button>
          <button type="button" onClick={() => setAnchor(today)}>
            今天
          </button>
          <button
            type="button"
            aria-label="查看更晚日期"
            title="查看更晚日期"
            disabled={!validCalendarDate(shiftDate(anchor, step))}
            onClick={() => setAnchor(shiftDate(anchor, step))}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="m10 6 6 6-6 6" />
            </svg>
          </button>
          <span className="gantt-range">
            <time dateTime={anchor}>{shortDate(anchor)}</time> –{" "}
            <time dateTime={viewportEnd}>{shortDate(viewportEnd)}</time>
          </span>
        </div>
        <div className="gantt-toolbar-options">
          <div className="gantt-scale" role="group" aria-label="时间轴缩放">
            <button
              type="button"
              aria-pressed={scale === "day"}
              onClick={() => setScale("day")}
            >
              日
            </button>
            <button
              type="button"
              aria-pressed={scale === "week"}
              onClick={() => setScale("week")}
            >
              周
            </button>
          </div>
          <TaskActionMenu label="甘特图选项" disabled={locked}>
            {(close) => (
              <>
                <label className="gantt-anchor-setting">
                  时间轴起日
                  <DatePicker
                    label="时间轴起日"
                    value={anchor}
                    disabled={locked}
                    onChange={setAnchor}
                  />
                </label>
                {deviations.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setCompare(!compare);
                      close();
                    }}
                  >
                    {compare
                      ? "收起每日安排对照"
                      : `每日安排对照 · ${deviations.length}`}
                  </button>
                )}
              </>
            )}
          </TaskActionMenu>
        </div>
      </div>
      {error && (
        <p className="error gantt-error" role="alert">
          {error}
          {pendingProposal && (
            <button
              type="button"
              disabled={locked}
              onClick={() => void apply(pendingProposal)}
            >
              重试保存
            </button>
          )}
          <button
            type="button"
            disabled={locked}
            onClick={async () => {
              if (saving.current) return;
              saving.current = true;
              setBusy(true);
              try {
                await onSaved();
                pending.current = null;
                committed.current = false;
                setPendingProposal(null);
                setPreview(null);
                setDraft(null);
                setError("");
              } catch (e) {
                setError(errorText(e));
              } finally {
                saving.current = false;
                setBusy(false);
              }
            }}
          >
            重新读取计划
          </button>
        </p>
      )}
      {draft && (
        <form
          aria-label="编辑甘特排期"
          className="workspace-editor gantt-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void prepare(
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
          <fieldset disabled={locked || !!preview || !!pendingProposal}>
            <div className="gantt-editor-heading">
              <h3>
                {tasks.find((task) => task.taskId === draft.taskId)?.title}
              </h3>
              <TaskActionMenu
                label="更多排期操作"
                disabled={locked || !!preview || !!pendingProposal}
              >
                {(close) => (
                  <button
                    type="button"
                    onClick={() => {
                      setDraft({ ...draft, start: "", end: "" });
                      close();
                    }}
                  >
                    清除计划日期
                  </button>
                )}
              </TaskActionMenu>
            </div>
            <div className="date-fields">
              <label>
                计划开始日
                <DatePicker
                  buttonRef={(button) => {
                    editorInput.current = button;
                  }}
                  label="计划开始日"
                  value={draft.start}
                  disabled={locked || !!preview || !!pendingProposal}
                  onChange={(date) => setDraft({ ...draft, start: date })}
                />
              </label>
              <label>
                计划结束日
                <DatePicker
                  label="计划结束日"
                  value={draft.end}
                  disabled={locked || !!preview || !!pendingProposal}
                  onChange={(date) => setDraft({ ...draft, end: date })}
                />
              </label>
            </div>
            {draft.entries.length > 1 && (
              <details className="gantt-dependencies">
                <summary>
                  前置任务
                  {draft.dependencies.length > 0
                    ? ` · ${draft.dependencies.length}`
                    : ""}
                </summary>
                <fieldset className="dependency-options">
                  <legend className="sr-only">前置任务（完成后开始）</legend>
                  {draft.entries
                    .filter((entry) => entry.taskId !== draft.taskId)
                    .map((entry) => (
                      <label key={entry.taskId}>
                        <input
                          type="checkbox"
                          checked={draft.dependencies.includes(entry.taskId)}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              dependencies: event.target.checked
                                ? [...draft.dependencies, entry.taskId]
                                : draft.dependencies.filter(
                                    (id) => id !== entry.taskId,
                                  ),
                            })
                          }
                        />
                        {
                          tasks.find((task) => task.taskId === entry.taskId)
                            ?.title
                        }
                      </label>
                    ))}
                </fieldset>
              </details>
            )}
            <div className="gantt-editor-actions">
              <button
                type="button"
                onClick={() => {
                  setDraft(null);
                  setError("");
                }}
              >
                取消编辑
              </button>
              <button type="submit" className="gantt-save">
                {busy ? "保存中…" : "保存排期"}
              </button>
            </div>
          </fieldset>
        </form>
      )}
      {preview && (
        <section
          className="schedule-preview gantt-preview"
          aria-label="排期调整预览"
        >
          <h3>确认排期调整 · {changed.length} 项</h3>
          <ul>
            {changed.map((entry) => {
              const before = preview.before.find(
                (item) => item.taskId === entry.taskId,
              )!;
              return (
                <li key={entry.taskId}>
                  <strong>
                    {tasks.find((task) => task.taskId === entry.taskId)?.title}
                  </strong>
                  <span>
                    {before.start
                      ? `${before.start} – ${before.end}`
                      : "未排期"}{" "}
                    → {entry.start ? `${entry.start} – ${entry.end}` : "未排期"}
                  </span>
                  {JSON.stringify([...before.dependencies].sort()) !==
                    JSON.stringify([...entry.dependencies].sort()) && (
                    <small>前置任务已调整</small>
                  )}
                </li>
              );
            })}
          </ul>
          <p>前置任务会使日期顺延；每日安排保持原日期。</p>
          <div className="gantt-editor-actions">
            <button
              type="button"
              disabled={locked || !!pendingProposal}
              onClick={() => setPreview(null)}
            >
              取消预览
            </button>
            <button
              type="button"
              className="gantt-save"
              disabled={locked || !!pendingProposal}
              onClick={() => void apply(preview)}
            >
              {busy ? "保存中…" : "确认应用排期"}
            </button>
          </div>
        </section>
      )}
      {compare && deviations.length > 0 && (
        <section
          className="gantt-arrangement-comparison"
          aria-label="每日安排对照"
        >
          <div className="gantt-comparison-heading">
            <h3>每日安排对照</h3>
            <button type="button" onClick={() => setCompare(false)}>
              收起
            </button>
          </div>
          {deviations.map((entry) => {
            const task = tasks.find((item) => item.taskId === entry.taskId)!;
            return (
              <p key={task.taskId}>
                <span>
                  {task.title}
                  <time dateTime={task.executionDate!}>
                    {task.executionDate}
                  </time>
                </span>
                <button
                  type="button"
                  disabled={editing}
                  onClick={() =>
                    onDay(task.completionDate ?? task.executionDate!)
                  }
                >
                  查看安排
                </button>
              </p>
            );
          })}
        </section>
      )}
      {tree.length > 0 && (
        <div className="gantt-scroll" tabIndex={0} aria-label="项目排期时间轴">
          <svg
            role="group"
            aria-label="按日项目排期与依赖"
            width={label + days * unit}
            height={Math.max(130, tree.length * rowHeight + 50)}
          >
            <defs>
              <marker
                id={graphId + "-arrow"}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-tertiary)" />
              </marker>
              <clipPath id={graphId + "-labels"}>
                <rect
                  x={0}
                  y={30}
                  width={label - 10}
                  height={tree.length * rowHeight + 20}
                />
              </clipPath>
            </defs>
            {Array.from({ length: days }, (_, index) => {
              const date = shiftDate(anchor, index);
              return (
                <g key={date}>
                  {[0, 6].includes(
                    new Date(date + "T12:00:00Z").getUTCDay(),
                  ) && (
                    <rect
                      className="gantt-weekend"
                      x={label + index * unit}
                      y={30}
                      width={unit}
                      height={tree.length * rowHeight + 20}
                      fill="var(--surface-secondary)"
                    />
                  )}
                  <line
                    className="gantt-grid-line"
                    x1={label + index * unit}
                    x2={label + index * unit}
                    y1={30}
                    y2={tree.length * rowHeight + 50}
                    stroke="var(--line)"
                  />
                  <text
                    x={label + index * unit + 4}
                    y={20}
                    fontSize={11}
                    fill="var(--text-secondary)"
                  >
                    {scale === "day" || index % 7 === 0
                      ? date.slice(5).replace("-", "/")
                      : ""}
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
                    strokeWidth={1.5}
                  />
                  <title>今日 {today}</title>
                </g>
              )}
            {tree.map((task, index) => {
              const entry = bounds(task);
              const start = entry.start ? daysBetween(anchor, entry.start) : 0,
                end = entry.end ? daysBetween(anchor, entry.end) : 0;
              const visible = entry.start && end >= 0 && start < days;
              const titleLength = Math.max(7, 14 - Math.min(task.depth, 5));
              return (
                <g
                  key={task.taskId}
                  className="gantt-task-row"
                  data-status={task.status}
                >
                  <line
                    x1={0}
                    x2={label + days * unit}
                    y1={index * rowHeight + 76}
                    y2={index * rowHeight + 76}
                    stroke="var(--line)"
                  />
                  <text
                    x={10 + Math.min(task.depth, 5) * 14}
                    y={index * rowHeight + 56}
                    fontSize={12}
                    fill="var(--text-tertiary)"
                    aria-hidden="true"
                  >
                    {task.hasChildren ? "⌄" : "·"}
                  </text>
                  <text
                    className="gantt-task-label"
                    x={26 + Math.min(task.depth, 5) * 14}
                    y={index * rowHeight + 56}
                    fontSize={13}
                    fontWeight={task.hasChildren ? 500 : 400}
                    fill="var(--text-primary)"
                    clipPath={`url(#${graphId}-labels)`}
                    role={task.hasChildren ? undefined : "button"}
                    tabIndex={task.hasChildren || editing ? -1 : 0}
                    aria-disabled={
                      !task.hasChildren && editing ? true : undefined
                    }
                    aria-label={"编辑任务排期：" + task.title}
                    onKeyDown={(event) => {
                      if (
                        !task.hasChildren &&
                        (event.key === "Enter" || event.key === " ")
                      ) {
                        event.preventDefault();
                        edit(task.taskId);
                      }
                    }}
                    onClick={() => !task.hasChildren && edit(task.taskId)}
                  >
                    {task.title.length > titleLength
                      ? task.title.slice(0, titleLength) + "…"
                      : task.title}
                    <title>{task.title}</title>
                  </text>
                  {visible && (
                    <rect
                      data-task-id={task.taskId}
                      role={task.hasChildren ? undefined : "button"}
                      aria-label={"编辑排期：" + task.title}
                      tabIndex={task.hasChildren || editing ? -1 : 0}
                      aria-disabled={
                        !task.hasChildren && editing ? true : undefined
                      }
                      x={label + Math.max(0, start) * unit + 2}
                      y={index * rowHeight + (task.hasChildren ? 44 : 38)}
                      width={
                        (Math.min(days - 1, end) - Math.max(0, start) + 1) *
                          unit -
                        4
                      }
                      height={task.hasChildren ? 12 : 24}
                      rx={4}
                      fill={
                        task.hasChildren
                          ? "var(--text-secondary)"
                          : task.status === "completed"
                            ? "var(--success-text)"
                            : "var(--primary)"
                      }
                      className={
                        task.hasChildren
                          ? "gantt-summary-bar"
                          : "gantt-task-bar"
                      }
                      style={{ touchAction: "none" }}
                      onKeyDown={(event) => {
                        if (
                          !task.hasChildren &&
                          (event.key === "Enter" || event.key === " ")
                        ) {
                          event.preventDefault();
                          edit(task.taskId);
                        }
                      }}
                      onPointerDown={(event) => {
                        if (
                          task.hasChildren ||
                          editing ||
                          saving.current ||
                          event.button !== 0
                        )
                          return;
                        event.currentTarget.setPointerCapture(event.pointerId);
                        setDrag({
                          id: task.taskId,
                          x: event.clientX,
                          entries,
                          version: project.planVersion ?? 0,
                        });
                      }}
                      onPointerCancel={() => setDrag(null)}
                      onPointerUp={(event) => {
                        if (!drag || drag.id !== task.taskId) return;
                        const delta = Math.round(
                          (event.clientX - drag.x) / unit,
                        );
                        setDrag(null);
                        const current = drag.entries.find(
                          (item) => item.taskId === task.taskId,
                        )!;
                        if (delta && current.start)
                          void prepare(
                            drag.entries,
                            {
                              ...current,
                              start: shiftDate(current.start, delta),
                              end: shiftDate(current.end!, delta),
                            },
                            drag.version,
                          );
                        else edit(task.taskId);
                      }}
                    >
                      <title>
                        {task.title}：{entry.start} ～ {entry.end}
                      </title>
                    </rect>
                  )}
                </g>
              );
            })}
            {entries.flatMap((entry) =>
              entry.dependencies.map((id) => {
                const from = entries.find((item) => item.taskId === id),
                  a = tree.findIndex((task) => task.taskId === id),
                  b = tree.findIndex((task) => task.taskId === entry.taskId);
                if (!from?.end || !entry.start || a < 0 || b < 0) return null;
                const x1 = label + (daysBetween(anchor, from.end) + 1) * unit,
                  x2 = label + daysBetween(anchor, entry.start) * unit,
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
                    key={entry.taskId + id}
                    d={`M ${x1} ${y1} H ${x1 + 8} V ${y2} H ${x2}`}
                    fill="none"
                    stroke="var(--text-tertiary)"
                    markerEnd={`url(#${graphId}-arrow)`}
                    pointerEvents="none"
                  />
                );
              }),
            )}
          </svg>
        </div>
      )}
    </section>
  );
}
