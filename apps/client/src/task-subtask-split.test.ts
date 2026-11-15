import { expect, test } from "vitest";
import { inspirationSplitText, subtaskTitles } from "./task-subtask-split";

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
