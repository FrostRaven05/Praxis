import { feedbackMessage } from "./feedback-message";
import { useEffect, useRef, useState } from "react";
import { subtree, type PersonalTaskChange } from "@praxis/application";
import { personalTasks } from "./personal-task-storage";

export function TaskProjectControl({
  taskId,
  projectId,
  projectName,
  disabled,
  onChanging,
  onChanged,
}: {
  taskId: string;
  projectId: string | null;
  projectName?: string | null;
  disabled?: boolean;
  onChanging?: () => Promise<boolean>;
  onChanged: () => Promise<void> | void;
}) {
  const [choices, setChoices] = useState<{ id: string; name: string }[]>(
    projectId ? [{ id: projectId, name: projectName || "当前项目" }] : [],
  );
  const [value, setValue] = useState(projectId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setValue(projectId ?? "");
  }, [projectId]);
  useEffect(() => {
    let active = true;
    void personalTasks
      .read()
      .then((base) => {
        if (!active) return;
        const current =
          base.work.tasks.find((task) => task.id === taskId)?.projectId ??
          projectId;
        const rows = base.work.projects
          .filter(
            (project) =>
              (project.status === "active" && !project.archivedAt) ||
              project.id === current,
          )
          .map((project) => ({ id: project.id, name: project.name }));
        setChoices(rows);
        setValue(current ?? "");
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [taskId, projectId]);
  async function choose(next: string) {
    const target = next || null;
    if (target === (value || null) || busy) return;
    const previous = value;
    setValue(next);
    setBusy(true);
    setError("");
    try {
      if (onChanging && !(await onChanging())) {
        if (alive.current) setValue(previous);
        return;
      }
      const base = await personalTasks.read();
      const change: PersonalTaskChange =
        subtree(base.work.tasks, taskId).length > 1
          ? { type: "move", projectId: target, confirmDescendants: true }
          : { type: "move", projectId: target };
      await personalTasks.change(base, taskId, change);
      if (alive.current) setValue(next);
      await onChanged();
    } catch (reason) {
      if (alive.current) {
        setValue(previous);
        setError(reason instanceof Error ? reason.message : "没有改到所属项目");
      }
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <div className="task-panel-project">
      <label>
        <span>所属项目</span>
        <select
          aria-label="所属项目"
          value={value}
          disabled={disabled || busy}
          onChange={(event) => void choose(event.target.value)}
        >
          <option value="">无</option>
          {choices.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p className="task-panel-project-error" role="alert">
          {feedbackMessage(error)}
        </p>
      )}
    </div>
  );
}
