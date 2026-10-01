import { useState } from "react";
import { calendarDate, projectStates, type Project } from "@praxis/application";
import { workspace } from "./storage";
export function ProjectLifecycle({
  project,
  onSaved,
}: {
  project: Project;
  onSaved: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false),
    [base, setBase] = useState(project),
    [status, setStatus] = useState(project.status ?? "active"),
    [arrangements, setArrangements] = useState<"keep" | "remove">("keep"),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  return (
    <section className="lifecycle">
      <span className="state-badge">
        {projectStates[project.status ?? "active"]}
      </span>
      <button
        onClick={() => {
          setBase(project);
          setStatus(project.status ?? "active");
          setArrangements("keep");
          setOpen(!open);
          setError("");
        }}
        disabled={busy}
      >
        管理项目状态
      </button>
      {open && (
        <form
          aria-label="项目生命周期"
          onSubmit={(e) => {
            e.preventDefault();
            setBusy(true);
            setError("");
            const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
            void workspace
              .execute({
                kind: "lifecycle",
                projectId: base.id,
                expectedVersion: base.version,
                status,
                focused: base.focused ?? false,
                arrangements: ["paused", "archived"].includes(status)
                  ? arrangements
                  : "keep",
                date: calendarDate(new Date(), zone),
              })
              .then(async () => {
                await onSaved();
                setOpen(false);
              })
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          <fieldset disabled={busy}>
            <label>
              项目状态
              <select
                aria-label="项目状态"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
              >
                {Object.entries(projectStates).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            {["paused", "archived"].includes(status) && (
              <label>
                已有每日安排
                <select
                  aria-label="已有每日安排"
                  value={arrangements}
                  onChange={(e) =>
                    setArrangements(e.target.value as "keep" | "remove")
                  }
                >
                  <option value="keep">保留全部安排</option>
                  <option value="remove">移出今天及以后未完成的安排</option>
                </select>
                <small>
                  过去的安排、完成事实和操作历史均保留；恢复项目不会自动恢复移出的安排。
                </small>
              </label>
            )}
            {status === "completed" && (
              <p>完成项目不会自动完成其任务，也不会生成执行记录。</p>
            )}
            <button>保存项目状态</button>{" "}
            <button type="button" onClick={() => setOpen(false)}>
              取消
            </button>
          </fieldset>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
        </form>
      )}
    </section>
  );
}
