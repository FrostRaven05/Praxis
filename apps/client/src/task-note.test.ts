import { describe, expect, it } from "vitest";
import {
  encodeNote,
  noteBody,
  notePlainText,
  noteSubtitle,
  parseNote,
  withNoteBody,
  withNoteSubtitle,
} from "./task-note";

const image = `data:image/jpeg;base64,${"a".repeat(40)}`;

describe("task notes", () => {
  it("keeps an existing plain description unchanged", () => {
    expect(encodeNote(parseNote("先写清楚做法"))).toBe("先写清楚做法");
    expect(notePlainText("先写清楚做法")).toBe("先写清楚做法");
  });

  it("keeps text around an image and can read the text back", () => {
    const stored = encodeNote([
      { kind: "text", text: "现场" },
      { kind: "image", src: image },
      { kind: "text", text: "补充" },
    ]);
    expect(parseNote(stored)).toEqual([
      { kind: "text", text: "现场" },
      { kind: "image", src: image },
      { kind: "text", text: "补充" },
    ]);
    expect(notePlainText(stored)).toBe("现场\n补充");
  });

  it("keeps a plain note as the short subtitle", () => {
    expect(noteSubtitle("sf sfsd")).toBe("sf sfsd");
    expect(noteBody("sf sfsd")).toBe("");
    expect(withNoteSubtitle("sf sfsd", "先写一句")).toBe("先写一句");
  });

  it("keeps the subtitle when a picture is added below", () => {
    const stored = withNoteBody(
      "sf sfsd",
      encodeNote([
        { kind: "text", text: "现场" },
        { kind: "image", src: image },
      ]),
    );
    expect(noteSubtitle(stored)).toBe("sf sfsd");
    expect(noteBody(stored)).toContain("现场");
    expect(notePlainText(stored)).toBe("sf sfsd\n现场");
  });

  it("drops an image address that is not a picture", () => {
    expect(
      parseNote(
        JSON.stringify({
          praxisNote: 1,
          blocks: [{ kind: "image", src: "https://example.com/a.png" }],
        }),
      ),
    ).toEqual([{ kind: "text", text: "" }]);
  });
});
