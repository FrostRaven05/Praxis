import { describe, expect, it } from "vitest";
import { reorderIds } from "./subtask-order";

describe("subtask order", () => {
  it("moves a step before or after another", () => {
    expect(reorderIds(["a", "b", "c"], "c", "a", false)).toEqual(["c", "a", "b"]);
    expect(reorderIds(["a", "b", "c"], "a", "c", true)).toEqual(["b", "c", "a"]);
  });

  it("leaves the list alone when the drop does not change order", () => {
    expect(reorderIds(["a", "b"], "a", "b", false)).toBeNull();
    expect(reorderIds(["a", "b"], "a", "a", true)).toBeNull();
  });
});
