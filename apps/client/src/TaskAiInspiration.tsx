import { feedbackMessage } from "./feedback-message";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { assignPomodoroTask, readPomodoroState, writePomodoroState } from "./pomodoro";
import {
  applyInspirationRefine,
  applyInspirationSubtasks,
  loadTaskInspiration,
  type InspirationTurn,
  type TaskInspiration,
} from "./task-subtask-split";
import { useImeSubmit } from "./useImeSubmit";
import "./task-ai-inspiration.css";

const text = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

type InspirationEntry =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "assistant"; result: TaskInspiration };

interface EditableStep {
  id: string;
  title: string;
  detail: string;
  selected: boolean;
}

const QUICK_PROMPTS = [
  "拆得更细一点",
  "精简成 3 步",
  "补充具体执行要点",
  "换个更轻松的思路",
];

function summarizeAssistantResult(result: TaskInspiration): string {
  if (result.kind === "question") {
    return [result.summary, result.question].filter(Boolean).join(" ");
  }
  const parts: string[] = [];
  if (result.summary) parts.push(result.summary);
  if (result.steps.length) {
    parts.push(
      `建议步骤：${result.steps.map((step, i) => `${i + 1}. ${step.title}`).join("；")}`,
    );
  }
  if (result.question) parts.push(`追问：${result.question}`);
  return parts.join(" ");
}

function toHistory(entries: InspirationEntry[]): InspirationTurn[] {
  return entries.map((entry) =>
    entry.role === "user"
      ? { role: "user", text: entry.text }
      : { role: "assistant", text: summarizeAssistantResult(entry.result) },
  );
}

export function TaskAiInspiration({
  taskId,
  onClose,
  onChanged,
  onRefined,
  onStartedPomodoro,
}: {
  taskId: string;
  onClose: () => void;
  onChanged: () => Promise<unknown> | void;
  onRefined?: (value: { title: string; notes: string }) => void;
  onStartedPomodoro?: () => void;
}) {
  const [entries, setEntries] = useState<InspirationEntry[]>([]);
  const [steps, setSteps] = useState<EditableStep[]>([]);
  const [starterTitle, setStarterTitle] = useState("");
  const [reply, setReply] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"refine" | "split" | "starter" | null>(null);
  const [error, setError] = useState("");
  const [applied, setApplied] = useState({ refine: false, split: false, starter: false });
  const [copied, setCopied] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ime = useImeSubmit();

  const latestAssistantIndex = (() => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry && entry.role === "assistant") return i;
    }
    return -1;
  })();

  const latestAssistantEntry =
    latestAssistantIndex >= 0 ? entries[latestAssistantIndex] : undefined;
  const latestAssistant =
    latestAssistantEntry && latestAssistantEntry.role === "assistant"
      ? latestAssistantEntry.result
      : null;

  const latestReady = (() => {
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const entry = entries[i];
      if (entry && entry.role === "assistant" && entry.result.kind === "ready") {
        return entry.result;
      }
    }
    return null;
  })();

  const taskTitle =
    latestAssistant?.taskTitle ||
    latestReady?.taskTitle ||
    "";

  const waitingForAnswer =
    !loading &&
    (latestAssistant?.kind === "question" || Boolean(latestAssistant?.question));

  const selectedSteps = steps.filter((step) => step.selected && step.title.trim());

  function scrollToBottom() {
    requestAnimationFrame(() => {
      const el = bodyRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }

  async function requestTurn(history: InspirationTurn[], reset = false) {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError("");
    if (reset) {
      setEntries([]);
      setSteps([]);
      setStarterTitle("");
      setApplied({ refine: false, split: false, starter: false });
    }
    try {
      const next = await loadTaskInspiration(taskId, {
        history,
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      const entry: InspirationEntry = {
        id: crypto.randomUUID(),
        role: "assistant",
        result: next,
      };
      setEntries((prev) => (reset ? [entry] : [...prev, entry]));
      if (next.kind === "ready") {
        setSteps(
          next.steps.map((step, index) => ({
            id: `${entry.id}-${index}`,
            title: step.title,
            detail: step.detail,
            selected: true,
          })),
        );
        setStarterTitle(next.steps[0]?.title ?? "");
        setApplied({ refine: false, split: false, starter: false });
      }
      scrollToBottom();
      if (next.kind === "question" || next.question) {
        requestAnimationFrame(() => inputRef.current?.focus());
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(text(caught));
      scrollToBottom();
    } finally {
      if (abortRef.current === controller) {
        setLoading(false);
      }
    }
  }

  useEffect(() => {
    void requestTurn([], true);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      abortRef.current?.abort();
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      window.removeEventListener("keydown", onKey);
    };
  }, [taskId]);

  function sendFollowUp(overrideText?: string) {
    const content = (overrideText ?? reply).trim();
    if (!content || loading || busy !== null) return;
    const userEntry: InspirationEntry = {
      id: crypto.randomUUID(),
      role: "user",
      text: content,
    };
    const nextEntries = [...entries, userEntry];
    setEntries(nextEntries);
    if (overrideText === undefined) setReply("");
    scrollToBottom();
    void requestTurn(toHistory(nextEntries), false);
  }

  function retryLast() {
    if (loading) return;
    void requestTurn(toHistory(entries), entries.length === 0);
  }

  async function refine(draft: TaskInspiration) {
    if (!draft.summary || busy) return;
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
    const titles = selectedSteps.map((step) => step.title.trim()).filter(Boolean);
    if (!titles.length || busy) return;
    setBusy("split");
    setError("");
    try {
      await applyInspirationSubtasks(taskId, titles);
      await onChanged();
      setApplied((value) => ({ ...value, split: true }));
    } catch (caught) {
      setError(text(caught));
    } finally {
      setBusy(null);
    }
  }

  async function applyStarter(startPomodoro: boolean) {
    const title = starterTitle.trim();
    if (!title || busy) return;
    setBusy("starter");
    setError("");
    try {
      const created = await applyInspirationSubtasks(taskId, [title]);
      await onChanged();
      setApplied((value) => ({ ...value, starter: true }));
      if (startPomodoro && created[0]) {
        writePomodoroState(
          assignPomodoroTask(readPomodoroState(), created[0], Date.now()),
        );
        onStartedPomodoro?.();
        onClose();
      }
    } catch (caught) {
      setError(text(caught));
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!latestReady) return;
    const stepLines = steps
      .filter((s) => s.selected && s.title.trim())
      .map((s, i) => `${i + 1}. ${s.title.trim()}${s.detail ? ` — ${s.detail}` : ""}`)
      .join("\n");
    const parts = [
      latestReady.summary ? `智能完善\n${latestReady.summary}` : "",
      stepLines ? `智能拆解\n${stepLines}` : latestReady.splitText ? `智能拆解\n${latestReady.splitText}` : "",
    ].filter(Boolean);
    if (!parts.length) return;
    try {
      await navigator.clipboard.writeText(parts.join("\n\n"));
      setCopied(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("暂时无法复制");
    }
  }

  function toggleStep(id: string) {
    setSteps((prev) =>
      prev.map((step) =>
        step.id === id ? { ...step, selected: !step.selected } : step,
      ),
    );
  }

  function editStepTitle(id: string, value: string) {
    setSteps((prev) =>
      prev.map((step) => (step.id === id ? { ...step, title: value } : step)),
    );
  }

  return createPortal(
    <div
      className="task-ai-backdrop"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="task-ai-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="AI灵感"
      >
        <header className="task-ai-header">
          <div className="task-ai-title-group">
            <span className="task-ai-bulb" aria-hidden="true">
              <svg viewBox="0 0 24 24">
                <path d="M9 18h6M10 21h4" />
                <path d="M8.2 14.2A6 6 0 1 1 15.8 14c-.6.7-1.1 1.5-1.3 2.4H9.5c-.2-.9-.7-1.7-1.3-2.2Z" />
              </svg>
            </span>
            <div className="task-ai-title-text">
              <h2>AI 灵感</h2>
              {taskTitle && (
                <span className="task-ai-task-pill" title={taskTitle}>
                  {taskTitle}
                </span>
              )}
            </div>
          </div>
          <div className="task-ai-header-actions">
            <button
              type="button"
              className="task-ai-icon-btn"
              aria-label="重新开始"
              title="重新开始"
              disabled={loading || busy !== null}
              onClick={() => void requestTurn([], true)}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                <path d="M21 3v6h-6" />
              </svg>
            </button>
            <button
              type="button"
              className="task-ai-icon-btn"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="m6 6 12 12M18 6 6 18" />
              </svg>
            </button>
          </div>
        </header>

        <div className="task-ai-body" ref={bodyRef}>
          {entries.map((entry, index) => {
            if (entry.role === "user") {
              return (
                <div key={entry.id} className="task-ai-turn is-user">
                  <div className="task-ai-bubble is-user">{entry.text}</div>
                </div>
              );
            }

            const result = entry.result;
            const isLatest = index === latestAssistantIndex;

            if (result.kind === "question") {
              return (
                <div key={entry.id} className="task-ai-turn is-assistant">
                  <article className="task-ai-card task-ai-question-card">
                    <header>
                      <h3>
                        <span className="task-ai-badge" aria-hidden="true">?</span>
                        需要补充一点信息
                      </h3>
                    </header>
                    <div className="task-ai-card-body">
                      {result.summary && (
                        <p className="task-ai-question-context">{result.summary}</p>
                      )}
                      <p className="task-ai-question-text">{result.question}</p>
                      {isLatest && !loading && (
                        <p className="task-ai-question-hint">
                          在下方输入框直接回复，我会结合你的回答继续拆解。
                        </p>
                      )}
                    </div>
                  </article>
                </div>
              );
            }

            if (!isLatest) {
              return (
                <div key={entry.id} className="task-ai-turn is-assistant is-history">
                  <article className="task-ai-card task-ai-history-card">
                    <header>
                      <h3>
                        <span aria-hidden="true">✦</span> 上一轮建议
                      </h3>
                    </header>
                    <div className="task-ai-card-body">
                      {result.summary && <p>{result.summary}</p>}
                      {result.steps.length > 0 && (
                        <ol className="task-ai-history-steps">
                          {result.steps.map((step, stepIndex) => (
                            <li key={stepIndex}>{step.title}</li>
                          ))}
                        </ol>
                      )}
                    </div>
                  </article>
                </div>
              );
            }

            return (
              <div key={entry.id} className="task-ai-turn is-assistant">
                {result.steps.length > 0 && (
                  <article className="task-ai-card task-ai-starter-card">
                    <header>
                      <h3>
                        <span aria-hidden="true">⚡</span> 先迈出第一步
                      </h3>
                    </header>
                    <div className="task-ai-card-body">
                      <p className="task-ai-card-hint">
                        如果这条任务太重，先只加一个最小起步子任务并立刻开干：
                      </p>
                      <input
                        className="task-ai-starter-input"
                        aria-label="起步动作"
                        value={starterTitle}
                        disabled={busy !== null || applied.starter}
                        maxLength={200}
                        onChange={(e) => setStarterTitle(e.target.value)}
                      />
                      <div className="task-ai-starter-actions">
                        <button
                          type="button"
                          className="task-ai-btn task-ai-btn-primary"
                          disabled={
                            busy !== null || applied.starter || !starterTitle.trim()
                          }
                          onClick={() => void applyStarter(true)}
                        >
                          {busy === "starter" ? "应用中…" : "▶ 加入并开番茄钟"}
                        </button>
                        <button
                          type="button"
                          className="task-ai-btn task-ai-btn-secondary"
                          disabled={
                            busy !== null || applied.starter || !starterTitle.trim()
                          }
                          onClick={() => void applyStarter(false)}
                        >
                          {applied.starter ? "✓ 已加入" : "仅加入这一步"}
                        </button>
                      </div>
                    </div>
                  </article>
                )}

                {result.summary && (
                  <article className="task-ai-card">
                    <header>
                      <h3>
                        <span aria-hidden="true">✦</span> 智能完善
                      </h3>
                      <button
                        type="button"
                        className={`task-ai-btn task-ai-btn-sm ${applied.refine ? "is-done" : "task-ai-btn-primary"}`}
                        disabled={busy !== null || applied.refine}
                        onClick={() => void refine(result)}
                      >
                        {busy === "refine"
                          ? "应用中…"
                          : applied.refine
                            ? "✓ 已应用"
                            : "应用"}
                      </button>
                    </header>
                    <div className="task-ai-card-body">
                      {result.title && result.title !== result.taskTitle && (
                        <div className="task-ai-suggested-title">
                          <span className="task-ai-label">建议标题</span>
                          <strong>{result.title}</strong>
                        </div>
                      )}
                      <p>{result.summary}</p>
                    </div>
                  </article>
                )}

                {steps.length > 0 && (
                  <article className="task-ai-card">
                    <header>
                      <h3>
                        <span aria-hidden="true">✦</span> 智能拆解
                      </h3>
                      <button
                        type="button"
                        className={`task-ai-btn task-ai-btn-sm ${applied.split ? "is-done" : "task-ai-btn-primary"}`}
                        disabled={
                          busy !== null || applied.split || selectedSteps.length === 0
                        }
                        onClick={() => void split()}
                      >
                        {busy === "split"
                          ? "应用中…"
                          : applied.split
                            ? "✓ 已应用"
                            : `应用所选 (${selectedSteps.length})`}
                      </button>
                    </header>
                    <div className="task-ai-card-body">
                      <ul className="task-ai-step-list">
                        {steps.map((step, stepIndex) => (
                          <li
                            key={step.id}
                            className={`task-ai-step-item ${step.selected ? "" : "is-muted"}`}
                          >
                            <label className="task-ai-step-check">
                              <input
                                type="checkbox"
                                checked={step.selected}
                                disabled={busy !== null || applied.split}
                                onChange={() => toggleStep(step.id)}
                              />
                              <span className="task-ai-step-num">{stepIndex + 1}</span>
                            </label>
                            <div className="task-ai-step-content">
                              <input
                                className="task-ai-step-input"
                                aria-label={`步骤 ${stepIndex + 1}`}
                                value={step.title}
                                disabled={busy !== null || applied.split}
                                maxLength={200}
                                onChange={(e) =>
                                  editStepTitle(step.id, e.target.value)
                                }
                              />
                              {step.detail && step.detail !== step.title.trim() && (
                                <p className="task-ai-step-detail">{step.detail}</p>
                              )}
                            </div>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </article>
                )}

                {result.question && (
                  <div className="task-ai-followup-note">
                    <span>AI 追问：</span>
                    {result.question}
                  </div>
                )}

                {!loading && (
                  <div className="task-ai-chips" aria-label="快捷追问">
                    {QUICK_PROMPTS.map((prompt) => (
                      <button
                        key={prompt}
                        type="button"
                        className="task-ai-chip"
                        disabled={busy !== null}
                        onClick={() => sendFollowUp(prompt)}
                      >
                        {prompt}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {loading && (
            <div className="task-ai-loading" role="status">
              <span className="task-ai-dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>
                {entries.length > 0 ? "正在根据你的回复调整建议…" : "正在生成灵感与拆解建议…"}
              </span>
            </div>
          )}

          {error && (
            <div className="task-ai-error" role="alert">
              <span>{feedbackMessage(error)}</span>
              <button
                type="button"
                className="task-ai-btn task-ai-btn-sm task-ai-btn-secondary"
                disabled={loading}
                onClick={retryLast}
              >
                重试
              </button>
            </div>
          )}
        </div>

        <footer className="task-ai-footer">
          <div className="task-ai-composer">
            <textarea
              ref={inputRef}
              className="task-ai-input"
              rows={1}
              aria-label="继续与 AI 对话"
              placeholder={
                waitingForAnswer
                  ? "回复 AI 的问题，继续生成拆解…"
                  : "继续对话：补充背景、调整拆解粒度或提出要求…"
              }
              value={reply}
              disabled={loading || busy !== null}
              maxLength={1000}
              onChange={(e) => setReply(e.target.value)}
              onCompositionStart={ime.onCompositionStart}
              onCompositionEnd={ime.onCompositionEnd}
              onKeyDown={(e) => {
                ime.onKeyDown(e);
                if (e.defaultPrevented) return;
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendFollowUp();
                }
              }}
            />
            <button
              type="button"
              className="task-ai-btn task-ai-btn-primary task-ai-send"
              disabled={loading || busy !== null || !reply.trim()}
              onClick={() => sendFollowUp()}
            >
              发送
            </button>
          </div>
          <div className="task-ai-meta">
            <span className="task-ai-disclaimer">内容由 AI 生成 · Enter 发送</span>
            <button
              type="button"
              className="task-ai-copy-btn"
              aria-label={copied ? "已复制" : "复制"}
              disabled={!latestReady}
              onClick={() => void copy()}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <rect x="8" y="8" width="11" height="11" rx="2" />
                <path d="M5 15V5h10" />
              </svg>
              <span>{copied ? "已复制" : "复制建议"}</span>
            </button>
          </div>
        </footer>
      </section>
    </div>,
    document.body,
  );
}
