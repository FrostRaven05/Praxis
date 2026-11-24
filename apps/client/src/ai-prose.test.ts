import { expect, test } from "vitest";
import { cleanAiProse } from "./ai-prose";

test("strips bracketed, labeled, and bare task UUIDs cleanly", () => {
  expect(
    cleanAiProse(
      "可从“ai灵感添加交互”（30794590-a5e1-431d-ac9d-283418d60e98）开始，先跑通对话。",
    ),
  ).toBe("可从“ai灵感添加交互”开始，先跑通对话。");

  expect(
    cleanAiProse(
      "建议先做「整理周报」 (id: 30794590-a5e1-431d-ac9d-283418d60e98) 。",
    ),
  ).toBe("建议先做「整理周报」。");

  expect(
    cleanAiProse(
      "先完成 任务ID: 30794590-a5e1-431d-ac9d-283418d60e98 这一项",
    ),
  ).toBe("先完成 这一项");
});
