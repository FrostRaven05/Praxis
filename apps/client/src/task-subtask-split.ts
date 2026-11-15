import type { AiGenerateRequest } from "../../api/src/ai-contract";
import { aiStorage } from "./ai-storage";
import { personalAgentStorage } from "./personal-agent-storage";
import { personalTasks } from "./personal-task-storage";

const cap = 20;

export function inspirationSplitText(steps: { title: string; detail: string }[]) {
  const order = ["第一", "第二", "第三", "第四", "第五", "第六", "第七"];
  const body = steps
    .map((step, index) => {
      const lead = order[index] ?? `第${index + 1}`;
      const detail = step.detail.trim();
      const extra = detail && detail !== step.title.trim() ? `，${detail}` : "";
      return `${lead}步是${step.title.trim()}${extra}。`;
    })
    .join("");
  return `我将这个任务拆分为${steps.length}个步骤。${body}`;
}

export function subtaskTitles(existing: string[], proposed: string[]) {
  const seen = new Set(existing.map((title) => title.trim()).filter(Boolean));
  const room = cap - seen.size;
  const titles: string[] = [];
  if (room <= 0) return titles;
  for (const raw of proposed) {
    const title = raw.trim();
    if (!title || seen.has(title)) continue;
    seen.add(title);
    titles.push(title);
    if (titles.length >= Math.min(7, room)) break;
  }
  return titles;
}

export interface TaskInspiration {
  summary: string;
  title: string;
  steps: { title: string; detail: string }[];
  splitText: string;
}

export async function loadTaskInspiration(taskId: string): Promise<TaskInspiration> {
  const base = await personalTasks.read();
  const task = base.query.task(taskId);
  if (!task) throw Error("任务已不存在，请重新读取");
  if (task.parentId) throw Error("子任务不能再拆子任务");
  const existing = base.work.tasks.filter(
    (item) => item.parentId === taskId && item.status !== "cancelled",
  );
  const snapshot = await personalAgentStorage.read(task.projectId ?? undefined);
  const context: AiGenerateRequest["context"] = task.projectId
    ? snapshot.context
    : {
        ...snapshot.context,
        project: null,
        tasks: [],
        ...(snapshot.context.personal
          ? {
              personal: {
                ...snapshot.context.personal,
                scope: "todos" as const,
                candidateTaskIds: [],
              },
            }
          : {}),
      };
  const request: AiGenerateRequest = {
    id: crypto.randomUUID(),
    mode: "decompose",
    input: [task.title, task.notes].filter(Boolean).join("\n").slice(0, 8000),
    constraints:
      "summary 用一段话说明如何把这条任务写得更可执行，可建议调整标题并补充备注要点，不要用列表。nextAction 只写建议采用的任务标题，不超过40个字。tasks 只包含3至7条子任务，title 是子任务标题，criteria 是这一步要看到的结果。不要创建顶层任务，不要修改日期。",
    context,
  };
  let run = await aiStorage.generate(request);
  for (let attempt = 0; attempt < 40 && run.status === "running"; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    run = await aiStorage.run(run.id);
  }
  if (run.status === "needs_input")
    throw Error(run.proposal?.question || "还需要补充条件才能拆分");
  if (run.status !== "ready" || !run.proposal)
    throw Error(run.error?.message || "没有生成可应用的建议");
  const steps = run.proposal.tasks
    .map((item) => ({ title: item.title.trim(), detail: (item.criteria || item.notes || "").trim() }))
    .filter((item) => item.title);
  const titles = subtaskTitles(
    existing.map((item) => item.title),
    steps.map((item) => item.title),
  );
  const kept = steps.filter((item) => titles.includes(item.title));
  const summary = run.proposal.summary.trim();
  const suggested = run.proposal.nextAction.trim();
  const title = suggested.length > 0 && suggested.length <= 80 ? suggested : task.title;
  if (!summary && !kept.length)
    throw Error("没有生成可应用的建议");
  return {
    summary,
    title,
    steps: kept,
    splitText: kept.length ? inspirationSplitText(kept) : "",
  };
}

export async function applyInspirationRefine(taskId: string, title: string, notes: string) {
  const base = await personalTasks.read();
  const task = base.query.task(taskId);
  if (!task) throw Error("任务已不存在，请重新读取");
  await personalTasks.change(base, taskId, {
    type: "edit",
    title: title.trim() || task.title,
    notes,
  });
}

export async function applyInspirationSubtasks(taskId: string, titles: string[]) {
  const base = await personalTasks.read();
  const task = base.query.task(taskId);
  if (!task) throw Error("任务已不存在，请重新读取");
  if (task.parentId) throw Error("子任务不能再拆子任务");
  const existing = base.work.tasks.filter(
    (item) => item.parentId === taskId && item.status !== "cancelled",
  );
  const next = subtaskTitles(
    existing.map((item) => item.title),
    titles,
  );
  if (!next.length)
    throw Error(existing.length >= cap ? "子任务已满 20 条" : "生成的子任务都已经存在");
  let current = base;
  for (const title of next) {
    await personalTasks.create(current, {
      taskId: crypto.randomUUID(),
      title,
      notes: "",
      deadline: null,
      projectId: task.projectId,
      parentId: task.id,
    });
    current = await personalTasks.read();
  }
}
