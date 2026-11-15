import { expect, it } from "vitest";
import { readRelease } from "./app-release.js";

it("accepts an https download on the release record and rejects other addresses", () => {
  const notes = "修复子任务布局";
  expect(
    readRelease({
      version: "0.2.0",
      notes,
      publishedAt: "2026-11-15T00:00:00.000Z",
      minimumVersion: "0.1.0",
      windows: {
        url: "https://todo.frostraven05.com/releases/Praxis.exe",
        sha256: "a".repeat(64),
      },
      android: null,
    }).windows?.url,
  ).toBe("https://todo.frostraven05.com/releases/Praxis.exe");
  expect(() =>
    readRelease({
      version: "0.2.0",
      notes,
      publishedAt: null,
      minimumVersion: "0.1.0",
      windows: { url: "http://todo.frostraven05.com/Praxis.exe", sha256: "a".repeat(64) },
      android: null,
    }),
  ).toThrow("invalid_release");
});
