import { useEffect, useRef, useState, type RefObject } from "react";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { TaskPanelIcon } from "../TaskPanelIcon";
import { ProjectIcon } from "../ProjectIcon";
import { unplannedTasks, sortedInboxTasks } from "./mobile-inbox-model";
import { ruleAt } from "./schedule-rules";
import "./quick-inbox.css";
type Props = {
  triggerRef: RefObject<HTMLButtonElement | null>;
  entities: WorkspaceEntity[];
  today: string;
  tomorrow: string;
  busy: boolean;
  pending: boolean;
  error: string;
  onClose: () => void;
  onSchedule: (task: WorkspaceEntity, date: string) => Promise<void>;
  onProject: (task: WorkspaceEntity, id: string) => Promise<void>;
  onEdit: (task: WorkspaceEntity) => void;
  onNavigate: (section: string) => void;
  onRetry: () => Promise<void>;
  onRefresh: () => Promise<void>;
};
export function QuickInbox(props: Props) {
  const dialog = useRef<HTMLDialogElement>(null),
    closeButton = useRef<HTMLButtonElement>(null);
  const [tab, setTab] = useState("tasks"),
    [project, setProject] = useState(""),
    [sort, setSort] = useState("created"),
    [descending, setDescending] = useState(true);
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
  const disabled = props.busy || props.pending;
  const live = props.entities.filter((e) => !e.deleted);
  const projects = live.filter(
    (e) =>
      e.kind === "project" && e.data.status === "active" && !e.data.archivedAt,
  );
  const pendingTasks = unplannedTasks(props.entities);
  const tasks = sortedInboxTasks(pendingTasks, project, sort, descending);
  const templates = live.filter((e) => e.kind === "recurrence");
  return (
    <dialog
      ref={dialog}
      className="pm-quick-inbox"
      aria-label="收件箱面板"
      onCancel={(event) => {
        event.preventDefault();
        props.onClose();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientY < rect.top ||
          event.clientX < rect.left ||
          event.clientX > rect.right
        )
          props.onClose();
      }}
    >
      <section className="pm-quick-layout">
        <header className="pm-quick-heading">
          <div className="pm-quick-tabs" role="tablist" aria-label="收件箱内容">
            <button
              type="button"
              role="tab"
              aria-label="待办箱"
              aria-selected={tab === "tasks"}
              aria-controls="quick-inbox-content"
              id="quick-tasks-tab"
              onClick={() => setTab("tasks")}
            >
              待办箱 <small>{pendingTasks.length}</small>
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "templates"}
              aria-controls="quick-inbox-content"
              id="quick-templates-tab"
              onClick={() => setTab("templates")}
            >
              任务模板
            </button>
          </div>
          <button
            type="button"
            className="pm-quick-close"
            ref={closeButton}
            aria-label="关闭收件箱"
            disabled={disabled}
            onClick={props.onClose}
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
        {props.error && (
          <div className="pm-quick-error" role="alert">
            <span>{props.error}</span>
            <button
              type="button"
              disabled={props.busy}
              onClick={() =>
                void (props.pending ? props.onRetry() : props.onRefresh())
              }
            >
              {props.pending ? "重试原操作" : "重新读取"}
            </button>
          </div>
        )}
        {tab === "tasks" && (
          <div className="pm-quick-filters">
            <select
              aria-label="筛选项目"
              value={project}
              disabled={disabled}
              onChange={(e) => setProject(e.target.value)}
            >
              <option value="">全部项目</option>
              <option value="unassigned">独立任务</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {String(p.data.title)}
                </option>
              ))}
            </select>
            <select
              aria-label="待办排序"
              value={sort}
              disabled={disabled}
              onChange={(e) => setSort(e.target.value)}
            >
              <option value="created">创建时间</option>
              <option value="priority">优先级</option>
              <option value="title">标题</option>
            </select>
            <select
              aria-label="排序方向"
              value={descending ? "desc" : "asc"}
              disabled={disabled}
              onChange={(e) => setDescending(e.target.value === "desc")}
            >
              <option value="desc">降序</option>
              <option value="asc">升序</option>
            </select>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setProject("");
                setSort("created");
                setDescending(true);
              }}
            >
              重置
            </button>
          </div>
        )}
        <div
          className="pm-quick-content"
          role="tabpanel"
          id="quick-inbox-content"
          aria-labelledby={
            tab === "tasks" ? "quick-tasks-tab" : "quick-templates-tab"
          }
        >
          {tab === "tasks" ? (
            <>
              {tasks.map((task) => {
                const title = String(task.data.title || "未命名任务"),
                  notes = String(
                    task.data.notes || task.data.description || "",
                  );
                return (
                  <article
                    className="pm-quick-task"
                    key={task.id}
                    data-task-id={task.id}
                  >
                    <button
                      type="button"
                      className="pm-quick-title"
                      disabled={disabled}
                      onClick={() => props.onEdit(task)}
                    >
                      {title}
                    </button>
                    {notes && <p>{notes}</p>}
                    <div className="pm-quick-actions">
                      <div className="pm-quick-dates">
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            void props.onSchedule(task, props.today)
                          }
                        >
                          移到今天
                        </button>
                        <button
                          type="button"
                          disabled={disabled}
                          onClick={() =>
                            void props.onSchedule(task, props.tomorrow)
                          }
                        >
                          移到明天
                        </button>
                        <label className="pm-quick-date">
                          <span>选择日期</span>
                          <input
                            type="date"
                            aria-label={`选择日期：${title}`}
                            value=""
                            disabled={disabled}
                            onChange={(e) => {
                              if (e.target.value)
                                void props.onSchedule(task, e.target.value);
                            }}
                          />
                        </label>
                      </div>
                      <label className="pm-quick-project">
                        <ProjectIcon name="folder" />
                        <select
                          aria-label={`设置项目：${title}`}
                          disabled={disabled}
                          value={String(task.data.projectId || "")}
                          onChange={(e) =>
                            void props.onProject(task, e.target.value)
                          }
                        >
                          <option value="">独立任务</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>
                              {String(p.data.title)}
                            </option>
                          ))}
                        </select>
                      </label>
                      <button
                        type="button"
                        className="pm-quick-edit"
                        aria-label={`编辑任务：${title}`}
                        disabled={disabled}
                        onClick={() => props.onEdit(task)}
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="currentColor"
                          aria-hidden="true"
                        >
                          <circle cx="5" cy="12" r="1.5" />
                          <circle cx="12" cy="12" r="1.5" />
                          <circle cx="19" cy="12" r="1.5" />
                        </svg>
                      </button>
                    </div>
                  </article>
                );
              })}
              {!tasks.length && (
                <div className="pm-quick-empty">
                  <TaskPanelIcon name="inbox" />
                  <h2>
                    {pendingTasks.length
                      ? "这个项目没有未安排任务"
                      : "待办箱已整理完毕"}
                  </h2>
                  <p>未安排日期的任务会显示在这里。</p>
                </div>
              )}
            </>
          ) : (
            <>
              {templates.map((template) => {
                const rule = ruleAt(template, props.today);
                return (
                  <article className="pm-quick-template" key={template.id}>
                    <div>
                      <h2>{String(template.data.title || "未命名模板")}</h2>
                      <p>
                        {rule.frequency === "daily"
                          ? "每天"
                          : rule.frequency === "weekly"
                            ? `每周 ${rule.target} 次`
                            : rule.frequency === "interval"
                              ? `每隔 ${rule.interval} 天`
                              : "指定星期"}{" "}
                        · {rule.paused || !rule.active ? "已暂停" : "启用中"}
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={disabled}
                      onClick={() => props.onNavigate("repeat")}
                    >
                      管理
                    </button>
                  </article>
                );
              })}
              {!templates.length && (
                <div className="pm-quick-empty">
                  <TaskPanelIcon name="sync" />
                  <h2>还没有任务模板</h2>
                  <p>设置重复规则，自动补充日常任务。</p>
                  <button
                    type="button"
                    disabled={disabled}
                    onClick={() => props.onNavigate("repeat")}
                  >
                    新建模板
                  </button>
                </div>
              )}
            </>
          )}
        </div>
        <footer className="pm-quick-footer">
          <span>
            {props.busy
              ? "正在保存…"
              : props.pending
                ? "等待保存确认"
                : "修改自动保存"}
          </span>
          <button
            type="button"
            disabled={disabled}
            onClick={() => props.onNavigate("inbox")}
          >
            整理收件箱原文 <ProjectIcon name="arrow" />
          </button>
        </footer>
      </section>
    </dialog>
  );
}
