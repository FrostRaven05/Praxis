import { Capacitor } from "@capacitor/core";
import { mobileStorage } from "./mobile-storage";
import { personalTasks } from "./personal-task-storage";
import { projectStorage } from "./storage";
import { mobileAiContext } from "./ai-context-mobile";
import { aiStorage } from "./ai-storage";
import {
  independentAgentMetadata,
  personalAgentSnapshot,
} from "./personal-agent-model";
import type { AiContextTask } from "../../api/src/ai-contract";

export const personalAgentStorage = {
  ...aiStorage,
  scope: async () => (await personalTasks.read()).scopeKey,
  async read(projectId?: string) {
    const base = await personalTasks.read();
    let metadata: AiContextTask[] = [];
    if (Capacitor.isNativePlatform()) {
      const raw = await mobileStorage.workspaceSnapshot();
      const ids = projectId ? [projectId] : base.work.projects.map((p) => p.id);
      for (const id of ids) {
        const p = raw.entities.find(
          (e) => !e.deleted && e.kind === "project" && e.id === id,
        );
        if (!p) {
          metadata.push(
            ...base.query
              .list(id)
              .map((t) => ({
                id: t.id,
                title: t.title,
                status: t.status,
                version: t.version,
                parentId: t.parentId,
                dependencies: [],
                estimatedMinutes: null,
              })),
          );
          continue;
        }
        // Closed projects contribute facts, but are never recommendation candidates.
        const safe = {
          ...p,
          data: { ...p.data, status: "active", archivedAt: null },
        };
        const tasks = raw.entities.filter(
          (e) => !e.deleted && e.kind === "task" && e.data.projectId === id,
        );
        for (let start = 0; start < Math.max(tasks.length, 1); start += 100) {
          const selected = new Set(
            tasks.slice(start, start + 100).map((t) => t.id),
          );
          const bounded = {
            ...raw,
            entities: raw.entities.filter(
              (e) =>
                e.kind !== "task" ||
                e.data.projectId !== id ||
                selected.has(e.id),
            ),
          };
          metadata.push(...mobileAiContext(bounded, safe).tasks);
        }
      }
      if (!projectId) metadata.push(...independentAgentMetadata(base.work));
    } else {
      const ids = projectId ? [projectId] : base.work.projects.map((p) => p.id);
      for (const id of ids) {
        const rows = await projectStorage.projectTasks(id);
        metadata.push(
          ...rows.map((t) => ({
            id: t.taskId,
            title: t.title,
            status: t.status,
            version: t.version,
            parentId: t.parentTaskId ?? null,
            dependencies: t.dependencies ?? [],
            estimatedMinutes: null,
            plannedStart: t.plannedStart ?? null,
            plannedEnd: t.plannedEnd ?? null,
            executionDate: t.executionDate,
          })),
        );
      }
      if (!projectId) metadata.push(...independentAgentMetadata(base.work));
    }
    const checked = await personalTasks.read();
    if (
      checked.scopeKey !== base.scopeKey ||
      JSON.stringify(
        checked.work.projects.map((p) => [p.id, p.version, p.planVersion]),
      ) !==
        JSON.stringify(
          base.work.projects.map((p) => [p.id, p.version, p.planVersion]),
        )
    )
      throw Error("账号或项目已变化，请重新打开行动助手。");
    return personalAgentSnapshot(checked, metadata, projectId);
  },
};
