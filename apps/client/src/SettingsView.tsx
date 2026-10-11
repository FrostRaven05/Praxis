import { BackupPanel } from "./BackupPanel";
import { ThemeSettings } from "./ThemeSettings";
import { AccountPanel } from "./AccountPanel";
import { ProjectIcon } from "./ProjectIcon";
import { useProjectList } from "./useProjectList";

export function SettingsView({
  revision,
  onOpenProject,
}: {
  revision: number;
  onOpenProject: (id: string) => void;
}) {
  const { items, error, loading, reload } = useProjectList(revision);
  const archived = items.filter(
    (project) => project.status === "archived" || !!project.archivedAt,
  );
  return (
    <section className="today settings-view" aria-labelledby="settings-heading">
      <div className="today-content">
        <header className="settings-heading">
          <h1 id="settings-heading">设置</h1>
          <p>管理用户账号、主题颜色、备份与归档项目。</p>
        </header>
        <AccountPanel />
        <ThemeSettings />
        <BackupPanel />
        <section className="settings-card" aria-labelledby="archived-heading">
          <header className="settings-card-heading">
            <span className="settings-section-icon">
              <ProjectIcon name="archive" />
            </span>
            <div>
              <h2 id="archived-heading">
                归档项目 <span>{archived.length}</span>
              </h2>
              <p>已归档的项目保存在这里，打开后可查看任务或恢复项目状态。</p>
            </div>
          </header>
          {error ? (
            <p className="error" role="alert">
              {error} <button onClick={reload}>重试</button>
            </p>
          ) : loading ? (
            <p className="settings-empty" role="status">
              正在读取归档项目…
            </p>
          ) : archived.length === 0 ? (
            <div className="settings-empty">
              <ProjectIcon name="archive" />
              <strong>暂无归档项目</strong>
              <p>项目归档后，会从左侧列表收起并显示在这里。</p>
            </div>
          ) : (
            <div className="archived-project-list">
              {archived.map((project) => (
                <button
                  key={project.id}
                  className="archived-project-card"
                  aria-label={`查看归档项目：${project.name}`}
                  onClick={() => onOpenProject(project.id)}
                >
                  <span className="archived-project-icon">
                    <ProjectIcon name="folder" />
                  </span>
                  <span className="archived-project-info">
                    <strong>{project.name}</strong>
                    <span>{project.outcome || "未填写预期结果"}</span>
                  </span>
                  <ProjectIcon name="arrow" />
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
    </section>
  );
}
