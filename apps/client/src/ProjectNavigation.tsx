import { feedbackMessage } from "./feedback-message";
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
        {visible.map((project) => (
          <button
            key={project.id}
            title={project.name}
            aria-current={selectedId === project.id ? "page" : undefined}
            disabled={disabled}
            className={
              selectedId === project.id
                ? "project-card selected"
                : "project-card"
            }
            onClick={() => onSelect(project.id)}
          >
            <span className="sidebar-project-icon" aria-hidden="true">
              {projectMark(project.name)}
            </span>
            <strong>{project.name}</strong>
            {selectedId === project.id && (
              <span className="project-selection-dot" aria-hidden="true" />
            )}
          </button>
        ))}
      </nav>
    </section>
  );
}

function projectMark(name: string) {
  const mark = Array.from(name.trim())[0];
  return mark ? mark.toLocaleUpperCase() : "项";
}
