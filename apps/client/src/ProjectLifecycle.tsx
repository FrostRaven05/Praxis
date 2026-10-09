import { projectStates, type Project } from "@praxis/application";
export function ProjectLifecycle({
  project,
}: {
  project: Project;
  onSaved: () => Promise<unknown>;
}) {
  return (
    <section className="lifecycle">
      <span className="state-badge">
        {projectStates[project.status ?? "active"]}
        {project.archivedAt ? " · 已归档" : ""}
      </span>
      <button
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("praxis-work-project", { detail: project.id }),
          )
        }
      >
        管理状态、归档与分区
      </button>
    </section>
  );
}
