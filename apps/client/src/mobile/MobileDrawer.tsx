import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { TaskPanelIcon } from "../TaskPanelIcon";
import { ProjectIcon } from "../ProjectIcon";
import { MobileNavIcon } from "./MobileNavIcon";
import "./mobile-drawer.css";

type Props = {
  triggerRef: RefObject<HTMLButtonElement | null>;
  section: string;
  projectId: string;
  entities: WorkspaceEntity[];
  today: string;
  timeZone: string;
  onClose: () => void;
  onNavigate: (section: string) => void;
  onProject: (id: string) => void;
  onCreateProject: () => void;
};

export function MobileDrawer(props: Props) {
  const { section, projectId, entities, onClose, onNavigate } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    element.showModal();
    closeButton.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      document.body.style.overflow = overflow;
      props.triggerRef.current?.focus({ preventScroll: true });
    };
  }, [props.triggerRef]);

  const live = entities.filter((e) => !e.deleted);
  const projects = live.filter(
    (e) =>
      e.kind === "project" && e.data.status === "active" && !e.data.archivedAt,
  );

  function link(key: string, label: string, icon: ReactNode, count?: number) {
    return (
      <button
        type="button"
        className="pm-drawer-link"
        key={key}
        aria-label={label}
        aria-description={
          count !== undefined && count > 0 ? `${count} 项待处理` : undefined
        }
        aria-current={section === key && !projectId ? "page" : undefined}
        onClick={() => onNavigate(key)}
      >
        {icon}
        <span>{label}</span>
        {count !== undefined && count > 0 && <small>{count}</small>}
      </button>
    );
  }

  return (
    <dialog
      ref={dialog}
      className="pm-drawer"
      aria-label="侧边菜单"
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        )
          onClose();
      }}
    >
      <nav className="pm-drawer-layout" aria-label="功能菜单">
        <header className="pm-drawer-heading">
          <span className="pm-drawer-brand">
            <b>P</b>Praxis
          </span>
          <button
            type="button"
            ref={closeButton}
            aria-label="关闭菜单"
            onClick={onClose}
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <path d="m6 6 12 12M18 6 6 18" />
            </svg>
          </button>
        </header>
        <div className="pm-drawer-scroll">
          <div className="pm-drawer-primary">
            {link("tasks", "今日", <TaskPanelIcon name="sun" />)}
            {link("todos", "杂事", <TaskPanelIcon name="check" />)}
            {link("habits", "习惯", <MobileNavIcon name="tasks" />)}
            {link("stats", "数据复盘", <MobileNavIcon name="stats" />)}
          </div>
          <section
            className="pm-drawer-group"
            aria-labelledby="drawer-projects"
          >
            <div className="pm-drawer-group-heading">
              <h2 id="drawer-projects">
                项目 <small>{projects.length}</small>
              </h2>
              <button
                type="button"
                aria-label="新建项目"
                onClick={props.onCreateProject}
              >
                <ProjectIcon name="plus" />
              </button>
            </div>
            {link("projects", "全部项目", <ProjectIcon name="folder" />)}
            {projects.map((project) => {
              const name = String(project.data.title ?? "未命名项目");
              const projectTasks = live.filter(
                (e) =>
                  e.kind === "task" &&
                  e.data.projectId === project.id &&
                  e.data.status !== "cancelled",
              );
              const doneCount = projectTasks.filter(
                (e) => e.data.status === "completed",
              ).length;
              const openCount = projectTasks.length - doneCount;
              const progressPct = projectTasks.length
                ? Math.round((doneCount / projectTasks.length) * 100)
                : 0;
              return (
                <button
                  key={project.id}
                  type="button"
                  className="pm-drawer-link pm-drawer-project"
                  aria-label={`打开项目：${name}`}
                  aria-current={projectId === project.id ? "page" : undefined}
                  onClick={() => props.onProject(project.id)}
                >
                  <span className="pm-drawer-project-badge" aria-hidden="true">
                    {Array.from(name.trim())[0]?.toUpperCase() || "项"}
                  </span>
                  <div className="pm-drawer-project-info">
                    <span className="pm-drawer-project-name">{name}</span>
                    {projectTasks.length > 0 && (
                      <span className="pm-drawer-project-bar" aria-hidden="true">
                        <i style={{ width: `${progressPct}%` }} />
                      </span>
                    )}
                  </div>
                  <small className="pm-drawer-project-count">
                    {projectTasks.length > 0
                      ? openCount > 0
                        ? `${openCount}`
                        : "✓"
                      : "0"}
                  </small>
                </button>
              );
            })}
            {!projects.length && (
              <p className="pm-drawer-empty">还没有项目，点击 ＋ 创建</p>
            )}
          </section>
        </div>
        <footer className="pm-drawer-footer">
          {link("trash", "回收站", <MobileNavIcon name="trash" />)}
          {link("settings", "我的", <ProjectIcon name="settings" />)}
        </footer>
      </nav>
    </dialog>
  );
}
