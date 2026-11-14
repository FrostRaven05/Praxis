import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { calendarDate } from "@praxis/application";
import { TaskPanelIcon } from "../TaskPanelIcon";
import { ProjectIcon } from "../ProjectIcon";
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
function offset(date: string, days: number) {
  const value = new Date(`${date}T12:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function MobileDrawer(props: Props) {
  const { section, projectId, entities, today, timeZone, onClose, onNavigate } =
    props;
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
  const weekDay = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7;
  const start = offset(today, -weekDay - 77);
  const activity = new Map<string, number>();
  for (const task of live) {
    if (
      task.kind !== "task" ||
      task.data.status !== "completed" ||
      typeof task.data.completedAt !== "string"
    )
      continue;
    const finished = new Date(task.data.completedAt);
    if (Number.isNaN(finished.getTime())) continue;
    const date = calendarDate(finished, timeZone);
    if (date >= start && date <= today)
      activity.set(date, (activity.get(date) ?? 0) + 1);
  }
  const completed = [...activity.values()].reduce((sum, n) => sum + n, 0);
  const days = Array.from({ length: 84 }, (_, i) => {
    const date = offset(start, i),
      count = activity.get(date) ?? 0;
    return {
      date,
      count,
      level: count === 0 ? 0 : count < 3 ? 1 : count < 6 ? 2 : 3,
    };
  });
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
          <section
            className="pm-drawer-activity"
            aria-label="最近十二周完成记录"
          >
            <div className="pm-drawer-metrics">
              <div>
                <strong>{completed}</strong>
                <span>完成任务</span>
              </div>
              <div>
                <strong>{activity.size}</strong>
                <span>活跃天数</span>
              </div>
              <small>近 12 周</small>
            </div>
            <div
              className="pm-drawer-heatmap"
              role="img"
              aria-label={`近十二周完成 ${completed} 项任务，活跃 ${activity.size} 天`}
            >
              {days.map((cell) => (
                <span
                  key={cell.date}
                  data-level={cell.level}
                  data-future={cell.date > today || undefined}
                  title={`${cell.date} · 完成 ${cell.count} 项`}
                />
              ))}
            </div>
          </section>
          <div className="pm-drawer-primary">
            {link("todos", "杂事", <TaskPanelIcon name="check" />)}
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
            {link("projects", "项目", <ProjectIcon name="folder" />)}
            {projects.map((project) => (
              <button
                key={project.id}
                type="button"
                className="pm-drawer-link pm-drawer-project"
                aria-label={`打开项目：${String(project.data.title ?? "未命名项目")}`}
                aria-current={projectId === project.id ? "page" : undefined}
                onClick={() => props.onProject(project.id)}
              >
                <ProjectIcon name="folder" />
                <span>{String(project.data.title ?? "未命名项目")}</span>
              </button>
            ))}
            {!projects.length && (
              <p className="pm-drawer-empty">还没有项目，点击 ＋ 创建</p>
            )}
          </section>
        </div>
        <footer className="pm-drawer-footer">
          {link("settings", "我的", <ProjectIcon name="settings" />)}
        </footer>
      </nav>
    </dialog>
  );
}
