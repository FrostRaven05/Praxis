import { useEffect, useRef, useState } from "react";
import {
  PersonalTaskRejectedError,
  type PersonalTaskDraft,
  type PersonalTaskRead,
} from "@praxis/application";
import type { PersonalTodoPort } from "./PersonalTodoHome";
import { useImeSubmit } from "./useImeSubmit";
import "./personal-task-inline.css";

export function quickDates() {
  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const at = (n: number) => {
    const d = new Date();
    d.setDate(d.getDate() + n);
    return d;
  };
  const toSat = (6 - at(0).getDay() + 7) % 7 || 7;
  return [
    { label: "今天", date: fmt(at(0)) },
    { label: "明天", date: fmt(at(1)) },
    { label: "本周末", date: fmt(at(toSat)) },
    { label: "下周", date: fmt(at(7)) },
  ];
}

export function PersonalTaskComposer({
  base,
  projectId,
  port,
  disabled,
  onDraftChange,
  onCreated,
}: {
  base: PersonalTaskRead;
  projectId: string | null;
  port: PersonalTodoPort;
  disabled: boolean;
  onDraftChange: (dirty: boolean) => void;
  onCreated: (base: PersonalTaskRead, title: string) => void;
}) {
  const [title, setTitle] = useState(""),
    [date, setDate] = useState("");
  const [busy, setBusy] = useState(false),
    [unknown, setUnknown] = useState(false),
    [committed, setCommitted] = useState(false),
    [error, setError] = useState("");
  const input = useRef<HTMLInputElement>(null),
    active = useRef(false),
    continuing = useRef(false);
  const attempt = useRef<{
    base: PersonalTaskRead;
    draft: PersonalTaskDraft;
    committed: boolean;
  } | null>(null);
  const source = useRef(base),
    dirtyScope = useRef<string | null>(null);
  const ime = useImeSubmit();
  const dirty = !!(title || date || busy || unknown || committed);
  if (!dirty) {
    source.current = base;
    dirtyScope.current = null;
  } else dirtyScope.current ??= source.current.scopeKey;
  useEffect(() => {
    onDraftChange(dirty);
    return () => onDraftChange(false);
  }, [dirty, onDraftChange]);
  const locked = disabled || busy || unknown || committed;
  useEffect(() => {
    if (continuing.current && !locked) input.current?.focus();
  }, [locked]);
  const canCreate =
    projectId === null ||
    source.current.work.projects.some(
      (p) => p.id === projectId && p.status === "active" && !p.archivedAt,
    );
  async function submit() {
    if (active.current || disabled || ime.blocked()) return;
    active.current = true;
    setBusy(true);
    setError("");
    try {
      if (!attempt.current)
        attempt.current = {
          base: source.current,
          draft: {
            taskId: crypto.randomUUID(),
            title,
            notes: "",
            deadline: date ? { kind: "date", date } : null,
            projectId,
          },
          committed: false,
        };
      const next = attempt.current;
      if (!next.committed) {
        if (!port.create)
          throw new PersonalTaskRejectedError("当前入口不支持创建任务");
        await port.create(next.base, next.draft);
        next.committed = true;
        setCommitted(true);
        setUnknown(false);
      }
      const fresh = await port.read();
      if (fresh.scopeKey !== next.base.scopeKey)
        throw Error("账号或工作空间已变化，请返回原作用域后重新读取");
      if (!fresh.query.task(next.draft.taskId))
        throw Error("已保存任务暂不可见，请重新读取确认");
      onCreated(fresh, next.draft.title.trim());
      source.current = fresh;
      attempt.current = null;
      dirtyScope.current = null;
      setTitle("");
      setDate("");
      setCommitted(false);
      setUnknown(false);
      continuing.current = true;
      requestAnimationFrame(() => input.current?.focus());
    } catch (error) {
      if (
        !attempt.current?.committed &&
        error instanceof PersonalTaskRejectedError
      ) {
        attempt.current = null;
        setUnknown(false);
      } else if (!attempt.current?.committed) setUnknown(true);
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  async function reread() {
    if (active.current || unknown || committed) return;
    active.current = true;
    setBusy(true);
    try {
      const fresh = await port.read();
      if (fresh.scopeKey !== (dirtyScope.current ?? source.current.scopeKey))
        throw Error("账号或工作空间已变化，请返回原作用域后再保存草稿");
      source.current = fresh;
      setError("已重新读取，草稿已保留，可再次保存。");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      active.current = false;
      setBusy(false);
    }
  }
  return (
    <form
      className="personal-task-composer"
      aria-label={projectId ? "添加项目任务" : "添加独立任务"}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="personal-task-capture-line">
        <input
          ref={input}
          data-personal-capture
          aria-label={projectId ? "项目任务标题" : "新任务标题"}
          placeholder="添加下一步，按回车保存"
          autoComplete="off"
          enterKeyHint="done"
          value={title}
          disabled={locked || !canCreate}
          onChange={(e) => {
            continuing.current = false;
            setTitle(e.target.value);
          }}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={ime.onKeyDown}
        />
        {(busy || unknown || committed) && (
          <button
            type="submit"
            className="primary"
            disabled={disabled || busy}
          >
            {busy ? "保存中…" : committed ? "重新读取任务" : "重试原操作"}
          </button>
        )}
      </div>
      {!canCreate && (
        <p>项目已结束或暂停；请先通过原项目设置恢复，再添加任务。</p>
      )}
      {error && (
        <div className="personal-task-inline-error" role="alert">
          {error}
          {committed
            ? "。任务已保存，重新读取不会重复提交。"
            : unknown
              ? "。保存结果未确认，请重试原操作。"
              : "。输入已保留。"}
          {!unknown && !committed && (
            <button
              type="button"
              disabled={busy || disabled}
              onClick={() => void reread()}
            >
              重新读取并保留草稿
            </button>
          )}
        </div>
      )}
      {error && !unknown && !committed && (
        <button
          type="button"
          disabled={busy || disabled}
          onClick={() => {
            attempt.current = null;
            setTitle("");
            setDate("");
            setError("");
          }}
        >
          清空草稿
        </button>
      )}
    </form>
  );
}
