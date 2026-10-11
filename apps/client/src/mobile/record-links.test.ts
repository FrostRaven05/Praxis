import { expect, it } from "vitest";
import { editRecordLinks, firstRecordLink } from "./record-links";
it("edits only the first displayed association and preserves additional links and extension fields", () => {
  const data = {
    projectId: "p1",
    taskId: "t1",
    links: [
      { targetType: "project", targetId: "p1", note: "keep metadata" },
      { targetType: "project", targetId: "p2" },
      { targetType: "task", targetId: "t1" },
      { targetType: "task", targetId: "t2" },
    ],
  };
  expect(editRecordLinks(data, "p3", "")).toEqual([
    { targetType: "project", targetId: "p3", note: "keep metadata" },
    { targetType: "project", targetId: "p2" },
    { targetType: "task", targetId: "t2" },
  ]);
  expect(editRecordLinks(data, "p1", "t1")).toEqual(data.links);
  expect(firstRecordLink({ links: data.links }, "project")).toBe("p1");
  expect(
    editRecordLinks({ projectId: "p1", taskId: "t1" }, "p1", "t1"),
  ).toEqual([
    { targetType: "project", targetId: "p1" },
    { targetType: "task", targetId: "t1" },
  ]);
});
