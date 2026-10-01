import { ProjectIcon } from "./ProjectIcon";
import { useProjectList } from "./useProjectList";

export function ProjectNavigation({
  revision,
  disabled,
  selectedId,
  onSelect,
  onCreate,
}: {
  revision: number;
  disabled: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onCreate: () => void;
}) {
  const { items, error, loading, reload } = useProjectList(revision);
  const visible = items.filter((project) => project.status !== "archived");
  return (
    <section className="sidebar-projects" aria-label="项目导航">
      <div className="sidebar-project-heading">
        <h2>
          项目 <span className="sidebar-project-count">{visible.length}</span>
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
          {error}
          <button onClick={reload}>重试</button>
        </p>
      ) : loading && items.length === 0 ? (
        <p className="sidebar-project-message" role="status">
          正在读取…
        </p>
      ) : !loading && visible.length === 0 ? (
        <p className="sidebar-project-message">还没有项目，点击新建开始。</p>
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
            <span className="sidebar-project-icon">
              <ProjectIcon name="folder" />
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
