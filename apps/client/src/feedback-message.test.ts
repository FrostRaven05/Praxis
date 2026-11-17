import { expect, it } from "vitest";
import { feedbackMessage } from "./feedback-message";

it.each([
  [new Error("Failed to fetch"), "连接暂时不可用，请重试。"],
  ["SQLITE_FULL: disk full", "存储空间不足，请清理后重试。"],
  ["STATE_CONFLICT", "内容已更新，请刷新后重试。"],
  ["UNAUTHORIZED", "登录已过期，请重新登录。"],
  [
    "未能确认操作结果，请重试；相同操作不会重复保存。",
    "保存结果未确认，请重试。",
  ],
  [new Error("SQLITE_ERROR: SELECT * FROM tasks"), "暂时无法完成，请重试。"],
  ['{"code":"unexpected","details":"trace"}', "暂时无法完成，请重试。"],
])("presents a concise recovery message for %s", (error, expected) => {
  expect(feedbackMessage(error)).toBe(expected);
});

it("preserves actionable validation, ownership and draft information", () => {
  expect(feedbackMessage(Error("USER:请填写任务标题"))).toBe("请填写任务标题");
  expect(feedbackMessage("账号已变化，请返回原账号后重试。输入已保留。")).toBe(
    "账号已变化，请返回原账号后重试。输入已保留。",
  );
});
