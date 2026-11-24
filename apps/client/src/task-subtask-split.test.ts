import { expect, test } from "vitest";
import {
  buildInspirationInput,
  inspirationSplitText,
  subtaskTitles,
} from "./task-subtask-split";

test("keeps new subtask titles under the remaining room and skips duplicates", () => {
  expect(subtaskTitles(["已有"], ["已有", "下一步", " 下一步 ", "收尾"])).toEqual([
    "下一步",
    "收尾",
  ]);
  expect(subtaskTitles(Array.from({ length: 20 }, (_, index) => String(index)), ["新的"])).toEqual(
    [],
  );
});

test("writes the split suggestion as one paragraph", () => {
  expect(
    inspirationSplitText([
      { title: "检查环境", detail: "开发依赖可以运行" },
      { title: "初始化项目", detail: "" },
    ]),
  ).toBe("我将这个任务拆分为2个步骤。第一步是检查环境，开发依赖可以运行。第二步是初始化项目。");
});

test("builds multi-turn inspiration input with conversation history", () => {
  expect(buildInspirationInput({ title: "准备周报", notes: "本周项目进度" })).toBe(
    "准备周报\n本周项目进度",
  );
  expect(
    buildInspirationInput(
      { title: "准备周报", notes: "" },
      [
        { role: "assistant", text: "这份周报面向团队还是管理层？" },
        { role: "user", text: "面向管理层，控制在3步以内" },
      ],
    ),
  ).toBe(
    "准备周报\n\n对话上下文：\n助手回复：这份周报面向团队还是管理层？\n用户补充：面向管理层，控制在3步以内",
  );
});
