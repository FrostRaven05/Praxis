import { useLanRefresh } from "./useLanRefresh";
import { TaskDetailsButton } from "./TaskDetailsButton";
import { useEffect, useState } from "react";
import {
  type ContentSnapshot,
  type ProjectContext,
  emptyContent,
  type ProjectTask,
} from "@praxis/application";
import { readContent, contentCommands, contentError } from "./content-storage";
import { RelatedRecords } from "./RelatedRecords";
export function ProjectContextPanel({
  projectId,
  tasks,
  onBusyChange,
}: {
  projectId: string;
  tasks: ProjectTask[];
  onBusyChange: (busy: boolean) => void;
}) {
  const [editVersion, setEditVersion] = useState<number | null>(null);
  const [data, setData] = useState<ContentSnapshot>(emptyContent),
    [base, setBase] = useState<ProjectContext | null>(null),
    [draft, setDraft] = useState<ProjectContext | null>(null);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [loading, setLoading] = useState(true);
  useLanRefresh(
    readContent,
    (d) => {
      setData(d);
      setBase(d.contexts.find((c) => c.projectId === projectId) ?? null);
    },
    busy || editing,
    projectId,
  );
  useEffect(() => {
    let active = true;
    setLoading(true);
    void readContent()
      .then((d) => {
        if (!active) return;
        setData(d);
        setBase(d.contexts.find((c) => c.projectId === projectId) ?? null);
        setError("");
      })
      .catch((e) => active && setError(contentError(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [projectId, tasks]);
  useEffect(() => {
    onBusyChange(busy || editing);
    return () => onBusyChange(false);
  }, [busy, editing, onBusyChange]);
  function start() {
    setEditVersion(base?.version ?? null);
    setDraft(
      base ?? {
        projectId,
        definitionOfDone: "",
        blockerText: "",
        reviewDate: null,
        nextActionTaskId: null,
        lastContext: "",
        restartHint: "",
        waitingNote: "",
        version: 0,
        updatedAt: "",
        nextActionCleared: 0,
      },
    );
    setEditing(true);
  }
  async function save() {
    if (!draft || busy) return;
    setBusy(true);
    try {
      const {
        version: _,
        updatedAt: __,
        nextActionCleared: ___,
        ...fields
      } = draft;
      await contentCommands.save({
        type: "context",
        expectedVersion: editVersion,
        ...fields,
      });
      setEditing(false);
      setDraft(null);
      const d = await readContent();
      setData(d);
      setBase(d.contexts.find((c) => c.projectId === projectId) ?? null);
      setError("");
    } catch (e) {
      setError(contentError(e));
    } finally {
      setBusy(false);
    }
  }
  const next = tasks.find((t) => t.taskId === base?.nextActionTaskId);
  return (
    <section className="content-card project-context" aria-label="项目上下文">
      <h2>下一步与恢复卡</h2>
      {loading ? (
        <p role="status">正在读取项目上下文…</p>
      ) : (
        <>
          {!!base?.nextActionCleared && (
            <p role="status">原下一步已失效，请重新指定。</p>
          )}
          {next ? (
            <div className="project-next-action">
              当前下一步：
              <TaskDetailsButton
                taskId={next.taskId}
                label={next.title}
                disabled={busy || editing}
              />
            </div>
          ) : (
            <p>尚未指定下一步。</p>
          )}
          {!editing ? (
            <>
              <div className="project-context-facts">
                <p>
                  <span>完成标准：</span>
                  {base?.definitionOfDone || "待补充"}
                </p>
                <p>
                  <span>主要阻塞：</span>
                  {base?.blockerText || "未记录"}
                </p>
                {base?.reviewDate && (
                  <p>
                    <span>下次复查：</span>
                    {base.reviewDate}
                  </p>
                )}
                <p>
                  <span>上次停在：</span>
                  {base?.lastContext || "写一句上下文，方便下次继续。"}
                </p>
                <p>
                  <span>下次从这里开始：</span>
                  {base?.restartHint || "未填写"}
                </p>
                <p>
                  <span>仍在等待：</span>
                  {base?.waitingNote || "未记录"}
                </p>
              </div>
              {base?.updatedAt && <small>更新于 {base.updatedAt}</small>}
              <button disabled={busy} onClick={start}>
                编辑恢复卡与下一步
              </button>
            </>
          ) : (
            draft && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <fieldset disabled={busy}>
                  <label>
                    主下一步
                    <select
                      aria-label="主下一步"
                      value={draft.nextActionTaskId ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          nextActionTaskId: e.target.value || null,
                        })
                      }
                    >
                      <option value="">暂不指定</option>
                      {data.tasks
                        .filter(
                          (t) =>
                            t.projectId === projectId &&
                            t.leaf &&
                            ["todo", "in_progress"].includes(t.status),
                        )
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  {(
                    [
                      ["definitionOfDone", "项目完成标准"],
                      ["blockerText", "主要阻塞"],
                      ["lastContext", "上次上下文"],
                      ["restartHint", "重新开始提示"],
                      ["waitingNote", "仍在等待"],
                    ] as const
                  ).map(([field, label]) => (
                    <label key={field}>
                      {label}
                      <textarea
                        aria-label={label}
                        value={draft[field]}
                        onChange={(e) =>
                          setDraft({ ...draft, [field]: e.target.value })
                        }
                      />
                    </label>
                  ))}
                  <label>
                    下次复查日期
                    <input
                      type="date"
                      value={draft.reviewDate ?? ""}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          reviewDate: e.target.value || null,
                        })
                      }
                    />
                  </label>
                  <button>保存项目上下文</button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditing(false);
                      setDraft(null);
                    }}
                  >
                    放弃修改
                  </button>
                </fieldset>
              </form>
            )
          )}
          <details>
            <summary>恢复卡活动记录</summary>
            {data.events
              .filter((e) => e.entityId === projectId)
              .map((e) => (
                <article key={e.id}>
                  <small>{e.occurredAt}</small>
                  {e.payload.action.type === "context" && (
                    <pre>
                      {e.payload.action.lastContext}
                      {"\n"}
                      {e.payload.action.restartHint}
                      {"\n"}
                      {e.payload.action.waitingNote}
                    </pre>
                  )}
                </article>
              ))}
          </details>
          <RelatedRecords targetType="project" targetId={projectId} />
        </>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
