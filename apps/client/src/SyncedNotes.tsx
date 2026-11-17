import { feedbackMessage } from "./feedback-message";
import { useEffect, useState } from "react";
import { invoke } from "./native-recovery";
import type { SyncedEntity } from "./LanSyncStatus";
import { useLanRefresh } from "./useLanRefresh";
const names: Record<string, string> = {
  strategy: "策略",
  decision: "决策",
  focus: "专注记录",
};
const templates: Record<string, string> = {
  strategy:
    "问题：\n\n指导方针：\n\n一致行动：\n\n明确不做：\n\n调整或停止条件：",
  decision:
    "事实：\n\n解释：\n\n替代解释：\n\n预期：\n\n检查日期：\n\n实际结果：\n\n更新：",
};
export function SyncedNotes({
  onBusyChange,
}: {
  onBusyChange: (busy: boolean) => void;
}) {
  const [entities, setEntities] = useState<SyncedEntity[]>([]),
    [draft, setDraft] = useState<SyncedEntity | null>(null),
    [base, setBase] = useState<SyncedEntity | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{
    operationId: string;
    entity: SyncedEntity;
    expected: SyncedEntity | null;
  } | null>(null);
  const read = () => invoke<SyncedEntity[]>("lan_entity_snapshot");
  useLanRefresh(read, setEntities, busy || !!draft);
  useEffect(() => {
    void read()
      .then(setEntities)
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(() => {
    onBusyChange(busy || !!draft);
    return () => onBusyChange(false);
  }, [busy, draft, onBusyChange]);
  async function save() {
    if (!draft || busy) return;
    const command = pending ?? {
      operationId: crypto.randomUUID(),
      entity: draft,
      expected: base,
    };
    setPending(command);
    setBusy(true);
    setError("");
    try {
      await invoke("lan_entity_edit", command);
      setPending(null);
      setDraft(null);
      setEntities(await read());
    } catch (e) {
      setError(String(e));
      if (/已变化|INVALID|STATE_CONFLICT/.test(String(e))) setPending(null);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="策略决策与专注">
      <h2>策略、决策与专注</h2>
      <p>与手机共享的策略、决策正文和专注记录。</p>
      {error && <p role="alert">{feedbackMessage(error)}</p>}
      {!draft && (
        <>
          <div>
            {["strategy", "decision"].map((kind) => (
              <button
                key={kind}
                onClick={() => {
                  const now = new Date().toISOString();
                  setBase(null);
                  setDraft({
                    id: crypto.randomUUID(),
                    kind,
                    version: 1,
                    data: { title: "", body: templates[kind] },
                    deleted: false,
                    createdAt: now,
                    updatedAt: now,
                  });
                }}
              >
                新建{names[kind]}
              </button>
            ))}
          </div>
          {entities
            .filter((e) => !e.deleted && e.kind in names)
            .map((e) => (
              <article key={e.id}>
                <h3>{String(e.data.title ?? names[e.kind])}</h3>
                <p>
                  {names[e.kind]}
                  {e.kind === "focus"
                    ? ` · ${Math.round(Number(e.data.durationSeconds ?? 0) / 60)} 分钟`
                    : ""}
                </p>
                <pre style={{ whiteSpace: "pre-wrap" }}>
                  {String(e.data.body ?? e.data.notes ?? "")}
                </pre>
                <button
                  onClick={() => {
                    setBase(e);
                    setDraft(e);
                  }}
                >
                  编辑 {String(e.data.title ?? names[e.kind])}
                </button>
              </article>
            ))}
        </>
      )}
      {draft && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <fieldset disabled={busy || !!pending}>
            <label>
              标题
              <input
                required
                value={String(draft.data.title ?? "")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    data: { ...draft.data, title: e.target.value },
                  })
                }
              />
            </label>
            <label>
              正文
              <textarea
                rows={14}
                value={String(draft.data.body ?? draft.data.notes ?? "")}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    data: { ...draft.data, body: e.target.value },
                  })
                }
              />
            </label>
            <button type="submit">保存内容</button>
            <button type="button" onClick={() => setDraft(null)}>
              取消
            </button>
          </fieldset>
          {pending && (
            <button type="button" disabled={busy} onClick={() => void save()}>
              重试保存内容
            </button>
          )}
        </form>
      )}
    </section>
  );
}
