import { expect, it } from "vitest";
import { compareVersions, releaseOffer, type AppRelease } from "./app-release.js";

const release = (patch: Partial<AppRelease> = {}): AppRelease => ({
  version: "0.2.0",
  notes: "修复子任务布局",
  publishedAt: null,
  minimumVersion: "0.1.0",
  windows: {
    url: "https://todo.frostraven05.com/releases/Praxis.exe",
    sha256: "ab".repeat(32),
  },
  android: null,
  ...patch,
});

it("orders numeric versions and ignores anything that is not major.minor.patch", () => {
  expect(compareVersions("0.1.0", "0.1.0")).toBe(0);
  expect(compareVersions("0.1.9", "0.2.0")).toBe(-1);
  expect(compareVersions("1.0.0", "0.9.9")).toBe(1);
  expect(compareVersions("0.1", "0.1.0")).toBeNull();
});

it("offers a same-host download only when a newer build is published", () => {
  expect(releaseOffer("0.2.0", release(), "windows").state).toBe("current");
  expect(releaseOffer("0.1.0", release(), "windows")).toMatchObject({
    state: "update",
    required: false,
    url: "https://todo.frostraven05.com/releases/Praxis.exe",
  });
  expect(releaseOffer("0.1.0", release({ windows: null }), "windows")).toMatchObject({
    state: "update",
    url: null,
  });
  expect(
    releaseOffer("0.1.0", release({ minimumVersion: "0.2.0" }), "windows"),
  ).toMatchObject({ required: true });
  expect(
    releaseOffer("0.1.0", release({
      windows: { url: "http://example.com/Praxis.exe", sha256: "ab".repeat(32) },
    }), "windows"),
  ).toMatchObject({ state: "update", url: null });
});
