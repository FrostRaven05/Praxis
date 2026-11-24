import type { AiGenerateRequest } from "../../api/src/ai-contract";
import { cleanAiProse } from "./ai-prose";
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

export interface InspirationTurn {
  role: "user" | "assistant";
  text: string;
}

export interface TaskInspiration {
  kind: "ready" | "question";
  taskTitle: string;
  summary: string;
  title: string;
  question: string | null;
  steps: { title: string; detail: string }[];
  splitText: string;
}

export function buildInspirationInput(
  task: { title: string; notes?: string | null },
  history: InspirationTurn[] = [],
) {
  const base = [task.title.trim(), task.notes?.trim() ?? ""].filter(Boolean).join("\n");
  if (!history.length) return base.slice(0, 8000);
  const dialog = history
    .map((turn) => {
      const content = turn.text.trim();
      if (!content) return "";
      return `${turn.role === "user" ? "用户补充" : "助手回复"}：${content}`;
    })
    .filter(Boolean)
    .join("\n");
  if (!dialog) return base.slice(0, 8000);
  return `${base}\n\n对话上下文：\n${dialog}`.slice(0, 8000);
}

function abortError() {
  return new DOMException("Aborted", "AbortError");
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function loadTaskInspiration(
  taskId: string,
  options?: { history?: InspirationTurn[]; signal?: AbortSignal },
): Promise<TaskInspiration> {
  const signal = options?.signal;
  if (signal?.aborted) throw abortError();
  const base = await personalTasks.read();
  if (signal?.aborted) throw abortError();
  const task = base.query.task(taskId);
  if (!task) throw Error("任务已不存在，请重新读取");
  if (task.parentId) throw Error("子任务不能再拆子任务");
  const existing = base.work.tasks.filter(
    (item) => item.parentId === taskId && item.status !== "cancelled",
  );
  const snapshot = await personalAgentStorage.read(task.projectId ?? undefined);
  if (signal?.aborted) throw abortError();
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
    input: buildInspirationInput(task, options?.history),
    constraints:
      "用自然温和的个人助理口吻结合对话上下文回复，不要出现任何任务ID、UUID或系统术语。summary 用1至2句通俗易懂的话说明如何把这条任务写得更清晰可执行，不要用列表。nextAction 只写建议采用的任务标题，不超过40个字。tasks 只包含3至7条子任务，title 是子任务标题，criteria 用口语化短句说明这一步做完后的样子。不要创建顶层任务，不要修改日期。",
    context,
  };
  let run = await aiStorage.generate(request);
  for (let attempt = 0; attempt < 40 && run.status === "running"; attempt += 1) {
    await sleep(1200, signal);
    run = await aiStorage.run(run.id);
    if (signal?.aborted) throw abortError();
  }
  if (run.status === "needs_input") {
    const question =
      cleanAiProse(run.proposal?.question) ||
      "还需要补充一点背景或目标条件，才能给出更贴合的拆解建议。";
    return {
      kind: "question",
      taskTitle: task.title,
      summary: cleanAiProse(run.proposal?.summary),
      title: task.title,
      question,
      steps: [],
      splitText: "",
    };
  }
  if (run.status !== "ready" || !run.proposal)
    throw Error(run.error?.message || "没有生成可应用的建议");
  const steps = run.proposal.tasks
    .map((item) => ({
      title: cleanAiProse(item.title),
      detail: cleanAiProse(item.criteria || item.notes || ""),
    }))
    .filter((item) => item.title);
  const titles = subtaskTitles(
    existing.map((item) => item.title),
    steps.map((item) => item.title),
  );
  const kept = steps.filter((item) => titles.includes(item.title));
  const summary = cleanAiProse(run.proposal.summary);
  const question = cleanAiProse(run.proposal.question) || null;
  const suggested = cleanAiProse(run.proposal.nextAction);
  const title = suggested.length > 0 && suggested.length <= 80 ? suggested : task.title;
  if (!summary && !kept.length) {
    if (question) {
      return {
        kind: "question",
        taskTitle: task.title,
        summary: "",
        title: task.title,
        question,
        steps: [],
        splitText: "",
      };
    }
    throw Error("没有生成可应用的建议");
  }
  return {
    kind: "ready",
    taskTitle: task.title,
    summary,
    title,
    question,
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
  const created: { id: string; title: string }[] = [];
  let current = base;
  for (const title of next) {
    const id = crypto.randomUUID();
    await personalTasks.create(current, {
      taskId: id,
      title,
      notes: "",
      deadline: null,
      projectId: task.projectId,
      parentId: task.id,
    });
    created.push({ id, title });
    current = await personalTasks.read();
  }
  return created;
}
