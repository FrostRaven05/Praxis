import { useEffect, useState } from "react";
import type { Project } from "@praxis/application";
import { projectStorage } from "./storage";
import { projects } from "./ProjectsView";
export function ProjectAssignment({
  task,
  onAssigned,
}: {
  task: { taskId: string; version?: number; projectId?: string | null };
  onAssigned: () => Promise<void>;
}) {
  const [items, setItems] = useState<Project[]>([]),
    [id, setId] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    void projectStorage
      .listProjects()
      .then((rows) => {
        if (active) {
          setItems(rows);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [reload]);
  if (task.projectId)
    return (
      <p className="task-meta">
        所属项目：
        {items.find((p) => p.id === task.projectId)?.name ?? "项目任务"}
      </p>
    );
  return (
    <div className="project-assignment">
      <select
        aria-label="归入项目"
        value={id}
        disabled={busy}
        onChange={(e) => setId(e.target.value)}
      >
        <option value="">选择已有项目</option>
        {items.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      <button
        disabled={busy || !id}
        onClick={() => {
          if (busy) return;
          setBusy(true);
          setError("");
          void projects
            .assign(task, id)
            .then(onAssigned)
            .catch((e) => setError(e instanceof Error ? e.message : String(e)))
            .finally(() => setBusy(false));
        }}
      >
        归入项目
      </button>
      {error && (
        <p role="alert" className="error">
          {error}
          <button onClick={() => setReload((n) => n + 1)}>重读项目列表</button>
        </p>
      )}
      {!items.length && !error && <small>先在「项目」中新建一个项目。</small>}
    </div>
  );
}
