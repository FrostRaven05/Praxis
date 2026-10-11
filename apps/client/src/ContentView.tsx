import { LanSyncStatus } from "./LanSyncStatus";
import { invoke } from "@tauri-apps/api/core";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  emptyContent,
  type ContentSnapshot,
  type CaptureItem,
  type ResolutionOutput,
  type ContentRecord,
  type RecordKind,
  type ContentLink,
  type Project,
} from "@praxis/application";
import { contentCommands, readContent, contentError } from "./content-storage";
import { projectStorage } from "./storage";
import { planning } from "./PlanningPanel";
import { InboxView } from "./InboxView";

export function ContentView({
  onScheduled,
  onBusyChange,
  focusRevision,
  onChanged,
}: {
  onScheduled: (date: string) => void;
  onBusyChange: (busy: boolean) => void;
  focusRevision: number;
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"captures" | "records" | "tasks">("captures");
  const [data, setData] = useState<ContentSnapshot>(emptyContent),
    [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [text, setText] = useState(""),
    [type, setType] = useState<"capture" | "task" | "record">("capture");
  const [rawEditing, setRawEditing] = useState<CaptureItem | null>(null);
  const [rawDraft, setRawDraft] = useState("");
  const [rawOperation, setRawOperation] = useState(() => crypto.randomUUID());
  const [captureId, setCaptureId] = useState(() => crypto.randomUUID());
  const [selected, setSelected] = useState<CaptureItem | null>(null),
    [editing, setEditing] = useState<ContentRecord | null | undefined>(
      undefined,
    );
  const [undo, setUndo] = useState<string | null>(null),
    [keep, setKeep] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [d, p] = await Promise.all([
        readContent(),
        projectStorage.listProjects(),
      ]);
      setData(d);
      setProjects(p);
      setError("");
    } catch (e) {
      setError(contentError(e));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  useEffect(() => {
    input.current?.focus();
  }, [focusRevision]);
  const syncBlocked = useRef(false);
  const syncRefresh = useCallback(() => {
    if (syncBlocked.current) return;
    void readContent()
      .then((d) => {
        if (!syncBlocked.current) setData(d);
      })
      .catch(() => undefined);
  }, []);
  const dirty =
    rawEditing !== null ||
    text.length > 0 ||
    selected !== null ||
    editing !== undefined ||
    undo !== null;
  syncBlocked.current = dirty || busy;
  useEffect(() => {
    if (!dirty && !busy) syncRefresh();
  }, [dirty, busy, syncRefresh]);
  useEffect(() => {
    onBusyChange(busy || dirty);
    return () => onBusyChange(false);
  }, [busy, dirty, onBusyChange]);
  async function run(fn: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    try {
      await fn();
      setNotice("已保存到本机，已配对的收集项将自动同步");
      await reload();
      onChanged();
    } catch (e) {
      setError(contentError(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  async function saveQuick() {
    await run(async () => {
      if (type === "task") {
        if ([...text].length > 500)
          throw new Error(
            "任务标题最多 500 个字符；多行文字可作为一条记录保存。",
          );
        await planning.capture(text);
      } else if (type === "record")
        await contentCommands.save({
          type: "record",
          id: captureId,
          expectedVersion: null,
          title: "",
          body: text,
          recordType: "note",
          links: [],
        });
      else
        await contentCommands.save({
          type: "capture",
          id: captureId,
          rawText: text,
        });
      setText("");
      setCaptureId(crypto.randomUUID());
    });
  }
  return (
    <section className="today content-view">
      <div className="today-content">
        <h1>收件箱与记录</h1>
        <LanSyncStatus onRefresh={syncRefresh} />
        <details>
          <summary>收集项同步活动记录</summary>
          {data.events
            .filter((e) =>
              [
                "capture_sync_received",
                "capture_raw_edited",
                "capture_sync_resolved",
              ].includes(e.kind),
            )
            .map((e) => (
              <article key={e.id}>
                <p>
                  {new Date(e.occurredAt).toLocaleString()} ·{" "}
                  {e.kind === "capture_sync_received"
                    ? "接收远端原文"
                    : e.kind === "capture_raw_edited"
                      ? "编辑原文"
                      : "处理同步冲突"}
                </p>
                <CaptureHistory payload={e.payload} />
              </article>
            ))}
        </details>
        <nav className="content-tabs" aria-label="内容类型">
          {(
            [
              ["captures", "待澄清原文"],
              ["records", "记录"],
              ["tasks", "独立任务"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              disabled={busy || dirty}
              aria-pressed={tab === id}
              onClick={() => setTab(id)}
            >
              {label}
            </button>
          ))}
        </nav>
        {tab === "tasks" ? (
          <InboxView
            onScheduled={onScheduled}
            onBusyChange={onBusyChange}
            focusRevision={focusRevision}
          />
        ) : (
          <>
            <form
              className="content-card"
              onSubmit={(e) => {
                e.preventDefault();
                void saveQuick();
              }}
            >
              <label>
                保存类型
                <select
                  disabled={busy}
                  value={type}
                  onChange={(e) => setType(e.target.value as typeof type)}
                >
                  <option value="capture">随手记</option>
                  <option value="task">任务</option>
                  <option value="record">记录</option>
                </select>
              </label>
              <label>
                原始文字
                <textarea
                  ref={input}
                  aria-label="原始文字"
                  value={text}
                  disabled={busy}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.nativeEvent.isComposing) return;
                    if (e.ctrlKey && e.key === "Enter") {
                      e.preventDefault();
                      void saveQuick();
                    }
                  }}
                  placeholder="先记下来，之后再整理。Ctrl+Enter 保存"
                />
              </label>
              <button disabled={busy || !text.trim()}>保存到本机</button>
              <button
                type="button"
                disabled={busy || !text}
                onClick={() => setText("")}
              >
                放弃输入
              </button>
            </form>
            {loading ? (
              <p role="status">正在读取…</p>
            ) : error ? null : tab === "captures" ? (
              <>
                {!data.captures.length && <p>暂无原文，先记录一件事。</p>}
                {data.captures.map((item) => (
                  <article
                    className="content-card"
                    data-capture-id={item.id}
                    key={item.id}
                  >
                    <pre>{item.rawText}</pre>
                    <button
                      disabled={busy || dirty}
                      onClick={() => {
                        setRawEditing(item);
                        setRawDraft(item.rawText);
                        setRawOperation(crypto.randomUUID());
                      }}
                    >
                      编辑原文
                    </button>
                    {rawEditing?.id === item.id && (
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          void run(async () => {
                            await invoke("lan_capture_edit", {
                              operationId: rawOperation,
                              id: item.id,
                              expectedVersion: rawEditing.version,
                              rawText: rawDraft,
                            });
                            setRawEditing(null);
                            setRawDraft("");
                          });
                        }}
                      >
                        <label>
                          编辑收集项原文
                          <textarea
                            aria-label="编辑收集项原文"
                            value={rawDraft}
                            disabled={busy}
                            onChange={(e) => {
                              setRawDraft(e.target.value);
                              setRawOperation(crypto.randomUUID());
                            }}
                          />
                        </label>
                        <button disabled={busy || !rawDraft.trim()}>
                          保存原文
                        </button>
                        <button
                          type="button"
                          disabled={busy}
                          onClick={() => {
                            setRawEditing(null);
                            setRawDraft("");
                          }}
                        >
                          取消编辑原文
                        </button>
                      </form>
                    )}
                    <p>
                      {item.state === "pending"
                        ? "待澄清"
                        : "已处理 · 原文保留"}
                    </p>
                    {!!item.retainedOutputs && (
                      <p className="error">
                        之前的输出已保留，请检查已有任务和记录，避免重复处理。
                      </p>
                    )}
                    {data.resolutions
                      .filter((r) => r.captureId === item.id)
                      .map((r) => (
                        <details key={r.id}>
                          <summary>
                            查看本次输出{r.undoneAt ? "（已撤销）" : ""}
                          </summary>
                          {r.outputs.map((o) => (
                            <p key={o.id}>
                              {o.kind === "task" ? "任务" : "记录"}：
                              {o.title || o.body.slice(0, 80)}
                            </p>
                          ))}
                        </details>
                      ))}
                    <button
                      disabled={busy || !!selected || editing !== undefined}
                      onClick={() => {
                        setUndo(null);
                        if (item.state === "pending") setSelected(item);
                        else {
                          setUndo(item.resolutionId);
                          setKeep(false);
                        }
                      }}
                    >
                      {item.state === "pending" ? "澄清原文" : "预览撤销"}
                    </button>
                  </article>
                ))}
              </>
            ) : (
              <>
                <button
                  disabled={busy || editing !== undefined}
                  onClick={() => setEditing(null)}
                >
                  新建记录
                </button>
                {!data.records.length && <p>暂无记录。</p>}
                {data.records.map((record) => (
                  <article key={record.id} className="content-card">
                    <h2>{record.title || "无标题记录"}</h2>
                    <pre>{record.body}</pre>
                    <p>
                      {record.recordType} · {record.links.length} 个关联
                    </p>
                    {record.sourceCaptureId && (
                      <details>
                        <summary>查看来源原文</summary>
                        <pre>
                          {
                            data.captures.find(
                              (c) => c.id === record.sourceCaptureId,
                            )?.rawText
                          }
                        </pre>
                      </details>
                    )}
                    <button
                      disabled={busy || editing !== undefined}
                      onClick={() =>
                        record.weeklyReview
                          ? window.dispatchEvent(
                              new CustomEvent("praxis-work-review", {
                                detail: record.id,
                              }),
                            )
                          : setEditing(record)
                      }
                    >
                      {record.weeklyReview ? "编辑周回顾" : "编辑记录和关联"}
                    </button>
                  </article>
                ))}
              </>
            )}
          </>
        )}
        {selected && (
          <ResolveEditor
            item={selected}
            projects={projects}
            busy={busy}
            onClose={() => setSelected(null)}
            onSave={(action) =>
              run(async () => {
                await contentCommands.save(action);
                setSelected(null);
              })
            }
          />
        )}
        {editing !== undefined && (
          <RecordEditor
            key={editing?.id ?? "new"}
            record={editing}
            data={data}
            projects={projects}
            busy={busy}
            onClose={() => setEditing(undefined)}
            onSave={(action) =>
              run(async () => {
                await contentCommands.save(action);
                setEditing(undefined);
              })
            }
          />
        )}
        {undo && (
          <section className="content-card" aria-label="撤销澄清预览">
            <h2>撤销澄清</h2>
            <p>
              恢复原文为待澄清。未编辑输出可撤回；已编辑或被关联时只能保留输出。澄清时新建的项目保留，避免影响后续工作。
            </p>
            {data.resolutions
              .find((r) => r.id === undo)
              ?.outputs.map((o) => (
                <p key={o.id}>
                  {o.kind === "task" ? "任务" : "记录"}：
                  {o.title || o.body.slice(0, 80)}
                </p>
              ))}
            <label>
              <input
                type="checkbox"
                checked={keep}
                disabled={busy}
                onChange={(e) => setKeep(e.target.checked)}
              />
              仅恢复原文，保留所有输出（需要检查重复）
            </label>
            <button
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await contentCommands.save({
                    type: "undo",
                    resolutionId: undo,
                    keepOutputs: keep,
                  });
                  setUndo(null);
                })
              }
            >
              确认撤销
            </button>
            <button disabled={busy} onClick={() => setUndo(null)}>
              返回检查
            </button>
          </section>
        )}
        {error && (
          <p className="error" role="alert">
            {error}{" "}
            <button disabled={busy} onClick={() => void reload()}>
              重新读取列表（保留草稿）
            </button>
          </p>
        )}
        <p role="status">{notice}</p>
      </div>
    </section>
  );
}
type Action = Parameters<typeof contentCommands.save>[0];
function ResolveEditor({
  item,
  projects,
  busy,
  onSave,
  onClose,
}: {
  item: CaptureItem;
  projects: Project[];
  busy: boolean;
  onSave: (a: Action) => Promise<void>;
  onClose: () => void;
}) {
  const [outputs, setOutputs] = useState<ResolutionOutput[]>([]),
    [project, setProject] = useState(""),
    [name, setName] = useState(""),
    [preview, setPreview] = useState(false);
  const [newId] = useState(() => crypto.randomUUID());
  function make(
    kind: "task" | "record",
    title: string,
    body = "",
  ): ResolutionOutput {
    return { id: crypto.randomUUID(), kind, title, body };
  }
  return (
    <section className="content-card" aria-label="澄清原文">
      <h2>澄清原文</h2>
      <pre>{item.rawText}</pre>
      <fieldset disabled={busy || preview}>
        <button
          onClick={() =>
            setOutputs(
              item.rawText
                .split(/\r?\n/)
                .filter((s) => s.trim())
                .map((s) => make("task", s.trim())),
            )
          }
        >
          每行一条任务
        </button>
        <button onClick={() => setOutputs([make("record", "", item.rawText)])}>
          作为一条记录
        </button>
        {outputs.map((o, index) => (
          <div className="content-output" key={o.id}>
            <label>
              类型
              <select
                value={o.kind}
                onChange={(e) =>
                  setOutputs(
                    outputs.map((v, i) =>
                      i === index
                        ? { ...v, kind: e.target.value as "task" | "record" }
                        : v,
                    ),
                  )
                }
              >
                <option value="task">任务</option>
                <option value="record">记录</option>
              </select>
            </label>
            <label>
              标题
              <input
                value={o.title}
                onChange={(e) =>
                  setOutputs(
                    outputs.map((v, i) =>
                      i === index ? { ...v, title: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
            <label>
              正文
              <textarea
                value={o.body}
                onChange={(e) =>
                  setOutputs(
                    outputs.map((v, i) =>
                      i === index ? { ...v, body: e.target.value } : v,
                    ),
                  )
                }
              />
            </label>
            <button
              onClick={() => setOutputs(outputs.filter((v) => v.id !== o.id))}
            >
              移除此输出
            </button>
          </div>
        ))}
        <button onClick={() => setOutputs([...outputs, make("task", "")])}>
          增加任务
        </button>
        <button onClick={() => setOutputs([...outputs, make("record", "")])}>
          增加记录
        </button>
        <label>
          目标项目
          <select value={project} onChange={(e) => setProject(e.target.value)}>
            <option value="">独立保留</option>
            <option value="new">新建项目</option>
            {projects
              .filter(
                (p) => !["completed", "archived"].includes(p.status ?? ""),
              )
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </select>
        </label>
        {project === "new" && (
          <label>
            新项目名称
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
        )}
      </fieldset>
      {preview ? (
        <>
          <p>
            将创建 {outputs.filter((o) => o.kind === "task").length} 条任务、
            {outputs.filter((o) => o.kind === "record").length} 条记录；目标：
            {project === "new"
              ? `新项目 ${name}（撤销澄清时保留项目）`
              : projects.find((p) => p.id === project)?.name || "独立保留"}
            。原文保留。
          </p>
          <button
            disabled={busy || !outputs.length}
            onClick={() =>
              void onSave({
                type: "resolve",
                captureId: item.id,
                expectedVersion: item.version,
                outputs,
                projectId: project && project !== "new" ? project : null,
                newProject: project === "new" ? { id: newId, name } : null,
              })
            }
          >
            确认创建
          </button>
          <button disabled={busy} onClick={() => setPreview(false)}>
            返回编辑
          </button>
        </>
      ) : (
        <button
          disabled={busy || !outputs.length}
          onClick={() => setPreview(true)}
        >
          预览输出
        </button>
      )}
      <button disabled={busy} onClick={onClose}>
        暂留原文
      </button>
    </section>
  );
}
function RecordEditor({
  record,
  data,
  projects,
  busy,
  onSave,
  onClose,
}: {
  record: ContentRecord | null;
  data: ContentSnapshot;
  projects: Project[];
  busy: boolean;
  onSave: (a: Action) => Promise<void>;
  onClose: () => void;
}) {
  const [id] = useState(() => record?.id ?? crypto.randomUUID()),
    [title, setTitle] = useState(record?.title ?? ""),
    [body, setBody] = useState(record?.body ?? ""),
    [kind, setKind] = useState<RecordKind>(record?.recordType ?? "note"),
    [links, setLinks] = useState<ContentLink[]>(record?.links ?? []);
  function toggle(targetType: ContentLink["targetType"], targetId: string) {
    setLinks(
      links.some((l) => l.targetType === targetType && l.targetId === targetId)
        ? links.filter(
            (l) => !(l.targetType === targetType && l.targetId === targetId),
          )
        : [...links, { targetType, targetId }],
    );
  }
  return (
    <form
      className="content-card"
      onSubmit={(e) => {
        e.preventDefault();
        void onSave({
          type: "record",
          id,
          expectedVersion: record?.version ?? null,
          title,
          body,
          recordType: kind,
          links,
        });
      }}
    >
      <h2>{record ? "编辑记录" : "新建记录"}</h2>
      <fieldset disabled={busy}>
        <label>
          记录标题
          <input
            aria-label="记录标题"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label>
          记录正文
          <textarea
            aria-label="记录正文"
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </label>
        <label>
          记录类型
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as RecordKind)}
          >
            {(
              [
                "note",
                "idea",
                "question",
                "evidence",
                "decision",
                "progress",
                "review",
              ] as const
            ).map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <details>
          <summary>关联项目和任务（{links.length}）</summary>
          {projects.map((p) => (
            <label key={p.id}>
              <input
                type="checkbox"
                checked={links.some(
                  (l) => l.targetType === "project" && l.targetId === p.id,
                )}
                onChange={() => toggle("project", p.id)}
              />
              {p.name}
            </label>
          ))}
          {data.tasks.map((t) => (
            <label key={t.id}>
              <input
                type="checkbox"
                checked={links.some(
                  (l) => l.targetType === "task" && l.targetId === t.id,
                )}
                onChange={() => toggle("task", t.id)}
              />
              {t.title}
            </label>
          ))}
        </details>
        <button type="submit">保存记录</button>
        <button type="button" onClick={onClose}>
          放弃修改
        </button>
      </fieldset>
    </form>
  );
}

function CaptureHistory({ payload }: { payload: unknown }) {
  if (!payload || typeof payload !== "object") return null;
  const entry = payload as {
    before?: { rawText?: unknown; deleted?: unknown } | null;
    after?: { rawText?: unknown; deleted?: unknown };
    copyId?: unknown;
  };
  return (
    <>
      <p>修改前{entry.before?.deleted ? "（已删除）" : ""}</p>
      <pre>
        {typeof entry.before?.rawText === "string"
          ? entry.before.rawText
          : "（原项尚不存在）"}
      </pre>
      <p>修改后{entry.after?.deleted ? "（已删除）" : ""}</p>
      <pre>
        {typeof entry.after?.rawText === "string" ? entry.after.rawText : ""}
      </pre>
      {!!entry.copyId && <p>本机文字已另存为新收集项。</p>}
    </>
  );
}
