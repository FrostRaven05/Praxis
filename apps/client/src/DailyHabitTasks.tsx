import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type KeyboardEventHandler,
} from "react";
import { RetriableCommands } from "../../../packages/application/src/retriable-commands";
import type { Row, Snapshot } from "./HabitsView";
import { useLanRefresh } from "./useLanRefresh";

type Command = {
  operationId: string;
  occurredAt: string;
  action: {
    type: "entry";
    id: string;
    date: string;
    status: "done" | null;
    note: string;
    timeZone: string;
    expectedVersion: number | null;
  };
};
const retries = new RetriableCommands<Command>();

export function readDailyHabits(date: string) {
  return invoke<Snapshot>("habit_snapshot", { date });
}

export function useDailyHabitTasks(
  date: string,
  enabled: boolean,
  blocked: boolean,
) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const scope = useRef(date);
  scope.current = date;
  const read = useCallback(() => readDailyHabits(date), [date]);
  const accept = useCallback((next: Snapshot) => {
    if (next.date === scope.current) setSnapshot(next);
  }, []);
  useLanRefresh(read, accept, !enabled || busy || blocked, date);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const refresh = () =>
      void read()
        .then((next) => {
          if (active) {
            accept(next);
            setError("");
          }
        })
        .catch((e) => {
          if (active) setError(String(e));
        });
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [date, enabled, read, accept]);

  async function toggle(row: Row) {
    if (
      !snapshot ||
      snapshot.date !== date ||
      pending.current ||
      blocked ||
      date > snapshot.today
    )
      return;
    pending.current = true;
    setBusy(true);
    setError("");
    const action: Command["action"] = {
      type: "entry",
      id: row.habit.id,
      date,
      status: row.entry?.status === "done" ? null : "done",
      note: row.entry?.note ?? "",
      timeZone: snapshot.timeZone,
      expectedVersion: row.entry?.version ?? null,
    };
    try {
      await retries.execute(
        `${row.habit.id}:${date}`,
        (c) => JSON.stringify(c.action) === JSON.stringify(action),
        () => ({
          operationId: crypto.randomUUID(),
          occurredAt: new Date().toISOString(),
          action,
        }),
        (command) => invoke("habit_command", { command }),
      );
      accept(await read());
      window.dispatchEvent(new Event("praxis-lan-sync"));
    } catch (e) {
      setError(
        String(e).includes("STATE_CONFLICT")
          ? "习惯记录已更新，请检查后重试。"
          : "习惯暂未保存，请再次勾选重试。",
      );
      // Keep the acknowledged version on transport failure so retries replay the same operation.
      if (String(e).includes("STATE_CONFLICT"))
        await read()
          .then(accept)
          .catch(() => {});
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const rows =
    snapshot?.date === date
      ? snapshot.habits.filter(
          (row) =>
            row.applicable &&
            row.entry?.status !== "skipped" &&
            (!row.collapsed || row.entry?.status === "done"),
        )
      : [];
  return {
    rows,
    busy,
    error,
    toggle,
    refresh: () => read().then(accept),
    future: snapshot ? date > snapshot.today : true,
  };
}

export function DailyHabitTask({
  row,
  disabled,
  onToggle,
  dragProps,
  dragClass = "",
  onMoveKeyDown,
  onDetails,
  selected = false,
  detailsDisabled = false,
}: {
  row: Row;
  disabled: boolean;
  onToggle: () => void;
  dragProps?: HTMLAttributes<HTMLLIElement>;
  dragClass?: string;
  onMoveKeyDown?: KeyboardEventHandler<HTMLButtonElement>;
  onDetails: () => void;
  selected?: boolean;
  detailsDisabled?: boolean;
}) {
  const done = row.entry?.status === "done";
  return (
    <li
      {...dragProps}
      className={`task-item habit-task${done ? " completed" : ""}${dragClass}`}
      data-habit-id={row.habit.id}
    >
      {!done && onMoveKeyDown && (
        <button
          className="task-drag-handle"
          disabled={!dragProps?.draggable}
          aria-label={`拖动排序：${row.habit.name}`}
          aria-describedby="task-sort-help"
          title="拖动排序；方向键调整顺序与时段"
          onKeyDown={onMoveKeyDown}
        >
          <svg viewBox="0 0 16 20" aria-hidden="true">
            <path d="M5 4h.01M11 4h.01M5 10h.01M11 10h.01M5 16h.01M11 16h.01" />
          </svg>
        </button>
      )}
      <button
        className="completion-toggle"
        aria-label={`${done ? "撤销完成" : "完成习惯"}：${row.habit.name}`}
        aria-pressed={done}
        disabled={disabled}
        onClick={onToggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          {done && <path className="completion-check" d="m7.5 12 3 3 6-6" />}
        </svg>
      </button>
      <button
        className={`task-row${selected ? " selected" : ""}`}
        aria-expanded={selected}
        disabled={detailsDisabled}
        onClick={onDetails}
      >
        <span className="task-text">
          <span className="task-title">{row.habit.name}</span>
        </span>
      </button>
      <span className="habit-task-kind">习惯</span>
    </li>
  );
}
