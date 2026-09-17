import { expect, it } from "vitest";
import {
  Projects,
  type ProjectStorage,
  type SaveProjectCommand,
  type AddProjectTasksCommand,
} from "./projects";
it("keeps project and batch task identities on ambiguous retry and validates input", async () => {
  const saves: SaveProjectCommand[] = [],
    batches: AddProjectTasksCommand[] = [];
  const storage: ProjectStorage = {
    async listProjects() {
      return [];
    },
    async projectTasks() {
      return [];
    },
    async assignProject() {},
    async saveProject(c) {
      saves.push(c);
      if (saves.length === 1) throw Error("lost reply");
    },
    async addProjectTasks(c) {
      batches.push(c);
      if (batches.length === 1) throw Error("lost reply");
    },
  };
  const projects = new Projects(storage);
  const fields = {
    name: "项目",
    outcome: "结果",
    targetDate: null,
    priority: 1,
  };
  await expect(projects.save(null, { ...fields, name: " " })).rejects.toThrow(
    "名称",
  );
  await expect(projects.save(null, fields)).rejects.toThrow();
  await projects.save(null, fields);
  expect(saves[1]).toEqual(saves[0]);
  await expect(projects.add("project", "一\n二")).rejects.toThrow();
  await projects.add("project", " 一\n\n二 ");
  expect(batches[1]).toEqual(batches[0]);
  expect(batches[0]?.tasks.map((t) => t.title)).toEqual(["一", "二"]);
  await expect(
    projects.save(null, { ...fields, targetDate: "2026-02-30" }),
  ).rejects.toThrow("日期");
});
