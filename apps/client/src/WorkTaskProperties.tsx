import { feedbackMessage } from "./feedback-message";
import { useEffect, useRef, useState } from "react";
import type { WorkSnapshot, WorkTask } from "@praxis/application";
import { openWorkTask, readWork, sendWorkAction } from "./ProductivityView";
import { DatePicker } from "./DatePicker";
import "./task-editor.css";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** Shared, immediate property edits for daily, project and inbox task panels. */
export function WorkTaskProperties({
  taskId,
  version,
  disabled,
  onSaved,
  onBusyChange,
}: {
  taskId: string;
  version: number;
  disabled: boolean;
  onSaved: () => Promise<unknown>;
  onBusyChange: (busy: boolean) => void;
}) {
  const [snapshot, setSnapshot] = useState<WorkSnapshot | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  const flight = useRef(false);
  const pending = useRef<{
    action: Parameters<typeof sendWorkAction>[0];
    draft: WorkTask;
    acknowledged: boolean;
  } | null>(null);
  useEffect(() => {
    if (!isTauri()) return;
    let live = true,
      off: (() => void) | undefined;
    void getCurrentWindow()
      .onCloseRequested((e) => {
        if (flight.current || pending.current) e.preventDefault();
      })
      .then((remove) => {
        if (live) off = remove;
        else remove();
      });
    return () => {
      live = false;
      off?.();
    };
  }, []);
  useEffect(() => {
    let live = true;
    void readWork()
      .then((s) => {
        if (live) {
          setSnapshot(s);
          setError("");
        }
      })
      .catch((e) => {
        if (live) setError(String(e));
      });
    return () => {
      live = false;
    };
  }, [taskId, version]);
  useEffect(() => {
    onBusyChange(busy || !!pending.current);
    return () => onBusyChange(false);
  }, [busy, error, onBusyChange]);
  const task = snapshot?.tasks.find((t) => t.id === taskId);
  async function save(
    patch?: Partial<Pick<WorkTask, "priority" | "labels" | "followUp">>,
  ) {
    if (flight.current || (!pending.current && (!task || disabled))) return;
    flight.current = true;
    setBusy(true);
    setError("");
    try {
      if (!pending.current && task)
        pending.current = {
          acknowledged: false,
          draft: { ...task, ...patch },
          action: {
            type: "task",
            id: task.id,
            expectedVersion: task.version,
            title: task.title,
            notes: task.notes,
            projectId: task.projectId,
            plan: task.plan,
            deadline: task.deadline,
            followUp: task.followUp,
            priority: task.priority,
            labels: task.labels,
            waitingFor: task.waitingFor,
            waitingNote: task.waitingNote,
            ...patch,
          },
        };
      const operation = pending.current!;
      if (!operation.acknowledged) {
        await sendWorkAction(operation.action);
        operation.acknowledged = true;
      }
      // Refresh the hosting panel too: every task write advances the same version.
      await onSaved();
      setSnapshot(await readWork());
      pending.current = null;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      flight.current = false;
      setBusy(false);
    }
  }
  const locked =
    disabled || busy || !!pending.current || !task || task.version !== version;
  const displayed = pending.current?.draft ?? task;
  return (
    <section className="work-task-properties" aria-label="任务属性">
      <fieldset disabled={locked}>
        <label>
          优先级
          <select
            aria-label="优先级"
            value={displayed?.priority ?? 4}
            onChange={(e) => void save({ priority: Number(e.target.value) })}
          >
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                P{n}
                {n === 4 ? " · 普通" : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="property-follow-up">
          <span>跟进日期</span>
          <DatePicker
            label="跟进日期"
            clearable
            disabled={locked}
            value={
              displayed?.followUp?.kind === "date"
                ? displayed.followUp.date
                : ""
            }
            display={
              displayed?.followUp?.kind === "instant"
                ? "已设置时刻 · 更多属性中修改"
                : undefined
            }
            onChange={(date) =>
              void save({ followUp: date ? { kind: "date", date } : null })
            }
          />
        </div>
        {!!snapshot?.labels.length && (
          <div className="property-labels" aria-label="任务标签">
            {snapshot.labels.map((label) => (
              <label key={label.id}>
                <input
                  type="checkbox"
                  checked={displayed?.labels.includes(label.id) ?? false}
                  onChange={(e) =>
                    void save({
                      labels: e.target.checked
                        ? [...(task?.labels ?? []), label.id]
                        : task!.labels.filter((id) => id !== label.id),
                    })
                  }
                />
                {label.name}
              </label>
            ))}
          </div>
        )}
        <button
          type="button"
          className="property-more"
          onClick={() => openWorkTask(taskId)}
        >
          更多属性与结构…
        </button>
      </fieldset>
      {busy && <p role="status">正在保存属性…</p>}
      {error && (
        <div role="alert">
          {feedbackMessage(error)}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              pending.current
                ? void save()
                : void readWork()
                    .then(setSnapshot)
                    .then(() => setError(""))
                    .catch((e) => setError(String(e)))
            }
          >
            {pending.current ? "重试保存属性" : "重新读取属性"}
          </button>
          {pending.current && !busy && (
            <button
              type="button"
              onClick={async () => {
                pending.current = null;
                setBusy(true);
                try {
                  await onSaved();
                  setSnapshot(await readWork());
                  setError("");
                } catch (e) {
                  setError(String(e));
                } finally {
                  setBusy(false);
                }
              }}
            >
              放弃本次属性修改并重新读取
            </button>
          )}
        </div>
      )}
    </section>
  );
}
