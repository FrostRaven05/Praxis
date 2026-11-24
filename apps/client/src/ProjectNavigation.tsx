import { useEffect, useMemo, useState } from "react";
import { personalProjectList, type WorkSnapshot } from "@praxis/application";
import { feedbackMessage } from "./feedback-message";
import { personalTasks } from "./personal-task-storage";
import { ProjectIcon } from "./ProjectIcon";
import { useProjectList } from "./useProjectList";

export function ProjectNavigation({
  revision,
  disabled,
  selectedId,
  overviewSelected,
  onSelect,
  onCreate,
  onList,
}: {
  revision: number;
  disabled: boolean;
  selectedId: string | null;
  overviewSelected: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onList: () => void;
}) {
  const { items, error, loading, reload } = useProjectList(revision);
  const [work, setWork] = useState<WorkSnapshot | null>(null);

  useEffect(() => {
    let active = true;
    const read = () => {
      void personalTasks
        .read()
        .then((next) => {
          if (active) setWork(next.work);
        })
        .catch(() => {});
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      active = false;
      window.removeEventListener("focus", read);
    };
  }, [revision]);

  const progressMap = useMemo(() => {
    const map = new Map<string, { done: number; total: number; percentage: number }>();
    if (!work) return map;
    for (const row of personalProjectList(work, new Date())) {
      if (row.progress) {
        map.set(row.project.id, {
          done: row.progress.done,
          total: row.progress.total,
          percentage: row.progress.percentage ?? 0,
        });
      }
    }
    return map;
  }, [work]);

  const visible = items.filter(
    (project) => project.status !== "archived" && !project.archivedAt,
  );
  return (
    <section className="sidebar-projects" aria-label="项目导航">
      <div className="sidebar-project-heading">
        <h2>
          <button
            type="button"
            className="project-list-link"
            aria-label="项目总览"
            aria-current={overviewSelected ? "page" : undefined}
            title="查看全部项目"
            disabled={disabled}
            onClick={onList}
          >
            项目 <span className="sidebar-project-count">{visible.length}</span>
          </button>
        </h2>
        <button
          className="new-project-button"
          aria-label="新建项目"
          title="新建项目"
          disabled={disabled}
          onClick={onCreate}
        >
          <ProjectIcon name="plus" />
          新建
        </button>
      </div>
      {error ? (
        <p className="sidebar-project-message" role="alert">
          {feedbackMessage(error)}
          <button onClick={reload}>重试</button>
        </p>
      ) : loading && items.length === 0 ? (
        <p className="sidebar-project-message" role="status">
          正在读取…
        </p>
      ) : null}
      <nav className="sidebar-project-list" aria-label="项目列表">
        {visible.map((project) => {
          const goalText =
            project.outcome.trim() ||
            (project.targetDate ? `目标日期 ${project.targetDate}` : "未设置目标");
          const progress = progressMap.get(project.id);
          const done = progress?.done ?? 0;
          const total = progress?.total ?? 0;
          const pct = total > 0 ? Math.round((done / total) * 100) : 0;
          const tooltip = [project.name, project.outcome.trim()]
            .filter(Boolean)
            .join(" — ");
          return (
            <button
              key={project.id}
              title={tooltip}
              aria-current={selectedId === project.id ? "page" : undefined}
              disabled={disabled}
              className={
                selectedId === project.id
                  ? "project-card selected"
                  : "project-card"
              }
              onClick={() => onSelect(project.id)}
            >
              <div className="sidebar-project-head">
                <span className="sidebar-project-icon" aria-hidden="true">
                  {projectMark(project.name)}
                </span>
                <strong>{project.name}</strong>
                <span className="sidebar-project-pct">
                  {total > 0 ? `${done}/${total}` : "0"}
                </span>
              </div>
              <span className="sidebar-project-outcome">{goalText}</span>
              <span
                className="sidebar-project-bar"
                aria-label={`完成进度 ${pct}%`}
              >
                <i style={{ width: `${pct}%` }} />
              </span>
            </button>
          );
        })}
      </nav>
    </section>
  );
}

function projectMark(name: string) {
  const mark = Array.from(name.trim())[0];
  return mark ? mark.toLocaleUpperCase() : "项";
}
