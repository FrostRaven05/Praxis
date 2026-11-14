import { useEffect, useMemo, useState } from "react";
import {
  personalProjectList,
  projectStates,
  type WorkSnapshot,
} from "@praxis/application";
import "./personal-projects.css";

function useProjectRows(work: WorkSnapshot) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 15000);
    return () => window.clearInterval(timer);
  }, []);
  return useMemo(() => personalProjectList(work, now), [work, now]);
}

export function PersonalProjectProgress({
  work,
  projectId,
}: {
  work: WorkSnapshot;
  projectId: string;
}) {
  const row = useProjectRows(work).find((r) => r.project.id === projectId);
  return row ? <ProjectProgress row={row} hasTasks={work.tasks.some(t=>t.projectId===projectId)} /> : null;
}
function ProjectProgress({
  row,
  hasTasks,
}: {
  row: ReturnType<typeof personalProjectList>[number];
  hasTasks: boolean;
}) {
  const p = row.progress;
  return (
    <div className="personal-project-progress" aria-label="项目任务进度">
      {p ? (
        <>
          <span>
            {p.total
              ? `${p.done} / ${p.total} 已完成 · ${p.percentage}%`
              : hasTasks ? "暂无计入进度的任务" : "还没有任务"}
          </span>
          {p.total > 0 && (
            <progress
              max={100}
              value={p.percentage ?? 0}
              aria-label="完成比例"
            />
          )}
          <span className={p.overdue ? "personal-project-overdue" : ""}>
            逾期 {p.overdue}
          </span>
          {p.mode === "legacy-tree" && <small>按有效叶子任务统计</small>}
        </>
      ) : (
        <span role="alert">{row.error}，请打开原项目检查。</span>
      )}
    </div>
  );
}
export function PersonalProjectList({
  work,
  disabled,
  onOpen,
  onCreate,
  onEdit,
}: {
  work: WorkSnapshot;
  disabled: boolean;
  onOpen: (id: string) => void;
  onCreate: () => void;
  onEdit?: (id: string) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const rows = useProjectRows(work);
  const visible = rows.filter(
    (r) =>
      showArchived ||
      !(r.project.archivedAt || r.project.status === "archived"),
  );
  return (
    <section className="personal-project-list" aria-label="个人项目列表">
      <header>
        <div>
          <h2>我的项目</h2>
          <small>项目是任务的主题分组，在项目里拆解任务</small>
        </div>
        <button className="primary" disabled={disabled} onClick={onCreate}>
          新建项目
        </button>
      </header>
      {rows.some(
        (r) => r.project.archivedAt || r.project.status === "archived",
      ) && (
        <label className="personal-project-archive">
          <input
            type="checkbox"
            checked={showArchived}
            disabled={disabled}
            onChange={(e) => setShowArchived(e.target.checked)}
          />
          显示已归档项目
        </label>
      )}
      {!visible.length && (
        <div className="personal-project-empty">
          <span aria-hidden="true">⛰️</span>
          <p>还没有项目，创建第一个项目来拆解任务吧。</p>
        </div>
      )}
      {visible.map((row) => (
        <article
          className="personal-project-card"
          key={row.project.id}
          data-project-id={row.project.id}
        >
          <button
            className="personal-project-open"
            disabled={disabled}
            onClick={() => onOpen(row.project.id)}
          >
            <strong>{row.project.name}</strong>
            <span>
              {row.project.archivedAt
                ? "已归档"
                : (projectStates[row.project.status] ?? row.project.status)}
            </span>
          </button>
          {row.project.outcome && <p>{row.project.outcome}</p>}
          {row.project.targetDate && (
            <small>目标日期 {row.project.targetDate}</small>
          )}
          <ProjectProgress row={row} hasTasks={work.tasks.some(t=>t.projectId===row.project.id)} />
          {onEdit && (
            <div className="personal-project-card-actions">
              <button
                disabled={disabled}
                onClick={() => onEdit(row.project.id)}
              >
                编辑基本信息
              </button>
            </div>
          )}
        </article>
      ))}
    </section>
  );
}
