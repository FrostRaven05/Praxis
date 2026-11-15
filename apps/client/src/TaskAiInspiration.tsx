import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  applyInspirationRefine,
  applyInspirationSubtasks,
  loadTaskInspiration,
  type TaskInspiration,
} from "./task-subtask-split";

const text = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function TaskAiInspiration({
  taskId,
  onClose,
  onChanged,
  onRefined,
}: {
  taskId: string;
  onClose: () => void;
  onChanged: () => Promise<unknown> | void;
  onRefined?: (value: { title: string; notes: string }) => void;
}) {
  const [draft, setDraft] = useState<TaskInspiration | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"refine" | "split" | null>(null);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState({ refine: false, split: false });
  const [copied, setCopied] = useState(false);

  async function load() {
    setLoading(true);
    setError("");
    setDraft(null);
    setApplied({ refine: false, split: false });
    try {
      setDraft(await loadTaskInspiration(taskId));
    } catch (caught) {
      setError(text(caught));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [taskId]);

  async function refine() {
    if (!draft?.summary || busy) return;
    setBusy("refine");
    setError("");
    try {
      await applyInspirationRefine(taskId, draft.title, draft.summary);
      onRefined?.({ title: draft.title, notes: draft.summary });
      await onChanged();
      setApplied((value) => ({ ...value, refine: true }));
    } catch (caught) {
      setError(text(caught));
    } finally {
      setBusy(null);
    }
  }

  async function split() {
    if (!draft?.steps.length || busy) return;
    setBusy("split");
    setError("");
    try {
      await applyInspirationSubtasks(
        taskId,
        draft.steps.map((step) => step.title),
      );
      await onChanged();
      setApplied((value) => ({ ...value, split: true }));
    } catch (caught) {
      setError(text(caught));
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    const parts = [
      draft?.summary ? `智能完善\n${draft.summary}` : "",
      draft?.splitText ? `智能拆解\n${draft.splitText}` : "",
    ].filter(Boolean);
    if (!parts.length) return;
    try {
      await navigator.clipboard.writeText(parts.join("\n\n"));
      setCopied(true);
    } catch {
      setError("暂时无法复制");
    }
  }

  return createPortal(
    <div className="task-ai-backdrop" role="presentation">
      <section className="task-ai-sheet" role="dialog" aria-modal="true" aria-label="AI灵感">
        <header className="task-ai-header">
          <h2>
            <span className="task-ai-bulb" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M9 18h6M10 21h4" />
                <path d="M8.2 14.2A6 6 0 1 1 15.8 14c-.6.7-1.1 1.5-1.3 2.4H9.5c-.2-.9-.7-1.7-1.3-2.2Z" />
              </svg>
            </span>
            AI灵感
          </h2>
          <div className="task-ai-header-actions">
            <button type="button" aria-label="重新生成" disabled={loading || busy !== null} onClick={() => void load()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="12" cy="12" r="7" />
              </svg>
            </button>
            <button type="button" aria-label="关闭" onClick={onClose}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </header>
        <div className="task-ai-body">
          {loading && <p role="status">正在生成建议…</p>}
          {error && <p role="alert">{error}</p>}
          {draft?.summary && (
            <article className="task-ai-card">
              <header>
                <h3>
                  <span aria-hidden="true">✦</span> 智能完善
                </h3>
                <button type="button" disabled={busy !== null || applied.refine} onClick={() => void refine()}>
                  {busy === "refine" ? "应用中…" : applied.refine ? "已应用" : "应用"}
                </button>
              </header>
              <p>{draft.summary}</p>
            </article>
          )}
          {draft?.splitText && (
            <article className="task-ai-card">
              <header>
                <h3>
                  <span aria-hidden="true">✦</span> 智能拆解
                </h3>
                <button type="button" disabled={busy !== null || applied.split} onClick={() => void split()}>
                  {busy === "split" ? "应用中…" : applied.split ? "已应用" : "应用"}
                </button>
              </header>
              <p>{draft.splitText}</p>
            </article>
          )}
        </div>
        <footer className="task-ai-footer">
          <span>内容由AI生成</span>
          <button type="button" aria-label={copied ? "已复制" : "复制"} disabled={!draft} onClick={() => void copy()}>
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <rect x="8" y="8" width="11" height="11" rx="2" />
              <path d="M5 15V5h10" />
            </svg>
          </button>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
