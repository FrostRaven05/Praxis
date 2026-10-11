import { useState } from "react";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { mobileStorage } from "../../../../packages/storage-mobile/src/native";
import { entityTitle, projectEvidence, historySummary } from "./extras-model";
export function ProjectChecks({
  entities,
  today,
  onSelect,
}: {
  entities: WorkspaceEntity[];
  today: string;
  onSelect: (project: WorkspaceEntity) => void;
}) {
  return (
    <>
      <h3>项目检查</h3>
      <p className="mx-muted">
        停滞依据：14
        天内未记录完成任务或项目关联记录；不根据系统维护时间推断推进。
      </p>
      {entities
        .filter(
          (e) =>
            !e.deleted && e.kind === "project" && e.data.status === "active",
        )
        .map((p) => {
          const v = projectEvidence(p, entities, today);
          return (
            <article key={p.id}>
              <b>{entityTitle(p)}</b>
              <ul>
                {v.missingNext && <li>尚未设置有效下一步</li>}
                {v.reviewDue && <li>复查日期已到</li>}
                {v.overdue > 0 && <li>{v.overdue} 项任务逾期</li>}
                {v.waiting > 0 && <li>{v.waiting} 项等待跟进</li>}
                {v.stagnant && <li>最近 14 天未记录推进</li>}
                {!v.missingNext &&
                  !v.reviewDue &&
                  !v.overdue &&
                  !v.waiting &&
                  !v.stagnant && <li>当前未发现需要处理的检查项</li>}
              </ul>
              <button onClick={() => onSelect(p)}>为此项目写回顾</button>
            </article>
          );
        })}
    </>
  );
}
export function CommandHistory({ timeZone }: { timeZone: string }) {
  const [rows, setRows] = useState<{ time: string; actions: string[] }[]>([]),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [busy, setBusy] = useState(false);
  return (
    <section>
      <h3>本机操作历史</h3>
      <p className="mx-muted">
        只读查看最近 100 次已保存操作；完整历史包含在导出文件中。
      </p>
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError("");
          void mobileStorage
            .workspaceExport()
            .then((json) => {
              const parsed = JSON.parse(json) as {
                history: { occurred_at: string; payload: unknown }[];
              };
              setRows(
                parsed.history
                  .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
                  .slice(0, 100)
                  .map((h) => ({
                    time: h.occurred_at,
                    actions: historySummary(h.payload),
                  })),
              );
              setLoaded(true);
            })
            .catch((e) =>
              setError(e instanceof Error ? e.message : "无法读取历史"),
            )
            .finally(() => setBusy(false));
        }}
      >
        读取历史
      </button>
      {error && <p role="alert">{error}</p>}
      {loaded && !rows.length && <p>尚无已保存操作</p>}
      {rows.map((r, i) => (
        <article key={i}>
          <small>
            {new Intl.DateTimeFormat("zh-CN", {
              timeZone,
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(r.time))}
          </small>
          <ul>
            {r.actions.slice(0, 10).map((action, i) => (
              <li key={i}>{action}</li>
            ))}
          </ul>
          {r.actions.length > 10 && (
            <small>另有 {r.actions.length - 10} 项批量变更</small>
          )}
        </article>
      ))}
    </section>
  );
}
