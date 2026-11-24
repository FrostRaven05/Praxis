import { expect, test } from "vitest";
import { parentToAutoComplete } from "./next-step-handoff";

test("returns parent id when completing the only subtask", () => {
  expect(
    parentToAutoComplete("sub-1", [
      { id: "parent", parentId: null, status: "todo" },
      { id: "sub-1", parentId: "parent", status: "todo" },
    ]),
  ).toBe("parent");
});

test("returns parent id when all other non-cancelled siblings are completed", () => {
  expect(
    parentToAutoComplete("sub-2", [
      { id: "parent", parentId: null, status: "in_progress" },
      { id: "sub-1", parentId: "parent", status: "completed" },
      { id: "sub-2", parentId: "parent", status: "todo" },
      { id: "sub-cancelled", parentId: "parent", status: "cancelled" },
    ]),
  ).toBe("parent");
});

test("returns null when another active sibling remains", () => {
  for (const activeStatus of ["todo", "in_progress", "waiting", "blocked"] as const) {
    expect(
      parentToAutoComplete("sub-1", [
        { id: "parent", parentId: null, status: "todo" },
        { id: "sub-1", parentId: "parent", status: "todo" },
        { id: "sub-2", parentId: "parent", status: activeStatus },
      ]),
    ).toBeNull();
  }
});

test("returns null when parent is already terminal or task has no parent", () => {
  expect(
    parentToAutoComplete("top", [{ id: "top", parentId: null, status: "todo" }]),
  ).toBeNull();
  expect(
    parentToAutoComplete("sub-1", [
      { id: "parent", parentId: null, status: "completed" },
      { id: "sub-1", parentId: "parent", status: "todo" },
    ]),
  ).toBeNull();
  expect(
    parentToAutoComplete("sub-1", [
      { id: "parent", parentId: null, status: "cancelled" },
      { id: "sub-1", parentId: "parent", status: "todo" },
    ]),
  ).toBeNull();
});
