import { useEffect, useState } from "react";
import { projectStates, type Project } from "@praxis/application";
import { projectStorage } from "./storage";
export function TrackedProjects({
  revision,
  disabled,
  selectedId,
  onSelect,
}: {
  revision: number;
  disabled: boolean;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const [projects, setProjects] = useState<Project[]>([]),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true,
      query = 0;
    async function refresh() {
      const token = ++query;
      try {
        const items = await projectStorage.listProjects();
        if (active && token === query) {
          setProjects(items.filter((p) => p.focused));
          setError("");
        }
      } catch {
        if (active && token === query) setError("无法读取追踪项目");
      } finally {
        if (active && token === query) setLoading(false);
      }
    }
    void refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [revision, retry]);
  return (
    <section className="tracked-projects" aria-label="追踪项目快捷入口">
      <h2>
        追踪项目 <span>{projects.length}</span>
      </h2>
      {error ? (
        <p className="tracked-empty">
          {error}
          <button onClick={() => setRetry((n) => n + 1)}>重试</button>
        </p>
      ) : loading ? (
        <p className="tracked-empty">正在读取…</p>
      ) : projects.length === 0 ? (
        <p className="tracked-empty">
          在项目状态中开启追踪，即可从这里快速打开。
        </p>
      ) : null}
      <div className="tracked-project-list">
        {projects.map((p) => (
          <button
            key={p.id}
            disabled={disabled}
            className={
              selectedId === p.id
                ? "tracked-project selected"
                : "tracked-project"
            }
            aria-current={selectedId === p.id ? "page" : undefined}
            title={p.name}
            onClick={() => onSelect(p.id)}
          >
            <span className="tracked-project-dot" aria-hidden="true" />
            <span className="tracked-project-name">{p.name}</span>
            <small>{projectStates[p.status ?? "active"]}</small>
          </button>
        ))}
      </div>
    </section>
  );
}
