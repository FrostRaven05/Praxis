import { useEffect, useRef, useState } from "react";
import { mobileStorage } from "../../../../packages/storage-mobile/src/native";
import {
  WorkspaceRejectedError,
  type WorkspaceCommand,
  type WorkspaceEntity,
  type WorkspaceSnapshot,
} from "../../../../packages/storage-mobile/src/workspace";

type Output = { id: string; kind: "task" | "record"; version: number };
export function Inbox({
  snapshot,
  refresh,
  onBusyChange,
}: {
  snapshot: WorkspaceSnapshot;
  refresh: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [text, setText] = useState(""),
    [editing, setEditing] = useState<WorkspaceEntity | null>(null);
  const [source, setSource] = useState<WorkspaceEntity | null>(null),
    [target, setTarget] = useState<"task" | "record">("task");
  const [split, setSplit] = useState(false),
    [projectId, setProjectId] = useState("");
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<WorkspaceCommand | null>(null);
  const saving = useRef(false),
    composing = useRef(false);
  const captures = snapshot.entities.filter(
    (e) => e.kind === "capture" && !e.deleted,
  );
  const projects = snapshot.entities.filter(
    (e) => e.kind === "project" && !e.deleted && e.data.status === "active",
  );
  useEffect(() => {
    onBusyChange?.(busy || !!text || !!source || !!pending);
    return () => onBusyChange?.(false);
  }, [busy, text, source, pending, onBusyChange]);
  async function commit(command: WorkspaceCommand) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError("");
    setPending(command);
    try {
      await mobileStorage.workspaceCommand(command);
      setPending(null);
      setText("");
      setEditing(null);
      setSource(null);
      setNotice("已保存到本机");
      await refresh();
    } catch (e) {
      if (e instanceof WorkspaceRejectedError) setPending(null);
      setError(e instanceof Error ? e.message : "保存失败，输入已保留。");
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }
  const send = (changes: WorkspaceCommand["changes"]) =>
    void commit({
      operationId: crypto.randomUUID(),
      occurredAt: new Date().toISOString(),
      changes,
    });
  function save() {
    if (composing.current || !text.trim() || Array.from(text).length > 100000)
      return;
    send([
      {
        id: editing?.id ?? crypto.randomUUID(),
        kind: "capture",
        expectedVersion: editing?.version ?? null,
        data: {
          ...editing?.data,
          rawText: text,
          status: editing?.data.status ?? "inbox",
        },
      },
    ]);
  }
  const outputs = source
    ? split
      ? String(source.data.rawText)
          .split(/\r?\n/)
          .map((s) => s.trim())
          .filter(Boolean)
      : [String(source.data.rawText)]
    : [];
  function clarify() {
    if (!source || !outputs.length || outputs.length > 100) return;
    const refs: Output[] = outputs.map(() => ({
      id: crypto.randomUUID(),
      kind: target,
      version: 1,
    }));
    send([
      ...refs.map((ref, i) => ({
        id: ref.id,
        kind: ref.kind,
        expectedVersion: null,
        data:
          target === "task"
            ? {
                title: outputs[i],
                status: "todo",
                projectId: projectId || null,
                priority: 0,
                tags: [],
                sourceCaptureId: source.id,
              }
            : {
                title: outputs[i]!.split(/\r?\n/)[0],
                body: outputs[i],
                projectId: projectId || null,
                sourceCaptureId: source.id,
              },
      })),
      {
        id: source.id,
        kind: "capture",
        expectedVersion: source.version,
        data: { ...source.data, status: "clarified", outputs: refs },
      },
    ]);
  }
  function undo(capture: WorkspaceEntity) {
    const refs = (capture.data.outputs ?? []) as Output[];
    const referenced = (value: unknown, id: string): boolean =>
      value === id ||
      (Array.isArray(value)
        ? value.some((item) => referenced(item, id))
        : !!value &&
          typeof value === "object" &&
          Object.values(value).some((item) => referenced(item, id)));
    const outputIds = new Set(refs.map((ref) => ref.id));
    const changed = refs.some((ref) => {
      const entity = snapshot.entities.find((e) => e.id === ref.id);
      return (
        !entity ||
        entity.deleted ||
        entity.version !== ref.version ||
        snapshot.entities.some(
          (other) =>
            !other.deleted &&
            other.id !== capture.id &&
            !outputIds.has(other.id) &&
            referenced(other.data, ref.id),
        )
      );
    });
    if (
      !window.confirm(
        changed
          ? "输出已有后续修改或关联内容。恢复原文到待处理并保留所有输出？再次澄清可能产生重复内容。"
          : "撤销本次澄清？原文恢复待处理，未修改的输出移入回收站。",
      )
    )
      return;
    const removals = changed
      ? []
      : refs.map((ref) => {
          const entity = snapshot.entities.find((e) => e.id === ref.id)!;
          return {
            id: entity.id,
            kind: entity.kind,
            expectedVersion: entity.version,
            data: entity.data,
            deleted: true,
          };
        });
    send([
      ...removals,
      {
        id: capture.id,
        kind: "capture",
        expectedVersion: capture.version,
        data: {
          ...capture.data,
          status: "inbox",
          lastOutputs: refs,
          outputs: [],
        },
      },
    ]);
  }
  const disabled = busy || !!pending;
  return (
    <section className="pm-inbox">
      <p className="pm-local-note">本机收件箱 · 原文会保留，尚未接入云同步</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {pending && !busy && (
        <div>
          <p>上次保存结果未确认，请重试同一操作。</p>
          <button onClick={() => void commit(pending)}>重试保存</button>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <label>
          {editing ? "编辑原文" : "记下原文"}
          <textarea
            aria-label={editing ? "编辑原文" : "记下原文"}
            rows={4}
            value={text}
            disabled={disabled || !!source}
            onChange={(e) => setText(e.target.value)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            placeholder="想法、待办、线索，先原样记下来"
          />
        </label>
        {Array.from(text).length > 100000 && (
          <p role="alert">最多支持 100,000 个字符，原文未截断。</p>
        )}
        <button
          className="pm-primary"
          disabled={
            disabled ||
            !!source ||
            !text.trim() ||
            Array.from(text).length > 100000
          }
        >
          {busy ? "保存中…" : editing ? "保存原文编辑" : "保存原文"}
        </button>
        {(text || editing) && (
          <button
            type="button"
            disabled={disabled}
            onClick={() => {
              if (!text || window.confirm("放弃未保存的原文？")) {
                setText("");
                setEditing(null);
              }
            }}
          >
            取消输入
          </button>
        )}
      </form>
      {source && (
        <section className="pm-inbox-preview" aria-label="澄清预览">
          <h2>预览澄清</h2>
          <label>
            输出类型
            <select
              value={target}
              disabled={disabled}
              onChange={(e) => setTarget(e.target.value as "task" | "record")}
            >
              <option value="task">任务</option>
              <option value="record">记录</option>
            </select>
          </label>
          <label>
            <input
              type="checkbox"
              checked={split}
              disabled={disabled}
              onChange={(e) => setSplit(e.target.checked)}
            />
            每个非空行生成一条
          </label>
          <label>
            关联项目
            <select
              value={projectId}
              disabled={disabled}
              onChange={(e) => setProjectId(e.target.value)}
            >
              <option value="">不关联项目</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {String(p.data.title)}
                </option>
              ))}
            </select>
          </label>
          <p>
            将生成 {outputs.length} 条{target === "task" ? "任务" : "记录"}
            ，保留原文来源。
          </p>
          <ol>
            {outputs.slice(0, 100).map((value, i) => (
              <li key={i}>{value}</li>
            ))}
          </ol>
          {outputs.length > 100 && (
            <p role="alert">一次最多拆分 100 条，请先编辑原文。</p>
          )}
          <button
            className="pm-primary"
            disabled={disabled || !outputs.length || outputs.length > 100}
            onClick={clarify}
          >
            确认澄清
          </button>
          <button disabled={disabled} onClick={() => setSource(null)}>
            取消预览
          </button>
        </section>
      )}
      <h2>
        待处理 · {captures.filter((e) => e.data.status !== "clarified").length}
      </h2>
      {!captures.length && <p className="pm-empty">随手记下，稍后再整理。</p>}
      {captures
        .slice()
        .reverse()
        .map((c) => (
          <article className="pm-capture" key={c.id}>
            <p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
              {String(c.data.rawText)}
            </p>
            <small>
              {c.data.status === "clarified" ? "已澄清" : "待处理"} ·{" "}
              {new Date(c.updatedAt).toLocaleString()}
            </small>
            {Array.isArray(c.data.lastOutputs) &&
              c.data.lastOutputs.length > 0 &&
              c.data.status === "inbox" && (
                <p>曾生成过输出；再次澄清前请检查是否重复。</p>
              )}
            <div>
              <button
                disabled={disabled || !!text || !!source}
                onClick={() => {
                  setEditing(c);
                  setText(String(c.data.rawText));
                  setError("");
                }}
              >
                编辑原文
              </button>
              {c.data.status === "clarified" ? (
                <button
                  disabled={disabled || !!text || !!source}
                  onClick={() => undo(c)}
                >
                  撤销澄清
                </button>
              ) : (
                <button
                  disabled={disabled || !!text || !!source}
                  onClick={() => {
                    setSource(c);
                    setSplit(false);
                    setProjectId("");
                  }}
                >
                  预览澄清
                </button>
              )}
            </div>
          </article>
        ))}
    </section>
  );
}
