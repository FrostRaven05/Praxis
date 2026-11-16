import { expect, it } from "vitest";
import { readRelease } from "./app-release.js";
import { createHash } from "node:crypto";
import { createServer } from "./server.js";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
      windows: {
        url: "http://todo.frostraven05.com/Praxis.exe",
        sha256: "a".repeat(64),
      },
      android: null,
    }),
  ).toThrow("invalid_release");
});

it("downloads only named installers without exposing adjacent configuration or traversal paths", async () => {
  const directory = await mkdtemp(join(tmpdir(), "praxis-installers-"));
  const app = createServer({
    databasePath: ":memory:",
    devices: [],
    releaseDirectory: directory,
  });
  try {
    await mkdir(join(directory, "1.0.1"));
    await writeFile(
      join(directory, "1.0.1", "Praxis-1.0.1-windows-x64-setup.exe"),
      "test-windows-installer",
    );
    await writeFile(
      join(directory, "1.0.1", "Praxis-1.0.1-android.apk"),
      "test-android-installer",
    );
    await writeFile(
      join(directory, "1.0.1", "server.json"),
      "private configuration",
    );
    const win = await app.inject({
      url: "/releases/1.0.1/Praxis-1.0.1-windows-x64-setup.exe",
    });
    expect(win.statusCode).toBe(200);
    expect(win.body).toBe("test-windows-installer");
    expect(win.headers["content-disposition"]).toContain(
      'attachment; filename="Praxis-1.0.1-windows-x64-setup.exe"',
    );
    expect(win.headers["x-content-type-options"]).toBe("nosniff");
    const apk = await app.inject({
      url: "/releases/1.0.1/Praxis-1.0.1-android.apk",
    });
    expect(apk.statusCode).toBe(200);
    expect(apk.body).toBe("test-android-installer");
    expect(apk.headers["content-type"]).toBe(
      "application/vnd.android.package-archive",
    );
    const head = await app.inject({
      method: "HEAD",
      url: "/releases/1.0.1/Praxis-1.0.1-android.apk",
    });
    expect(head.statusCode).toBe(200);
    expect(head.body).toBe("");
    expect(head.headers["content-length"]).toBe(
      String(Buffer.byteLength("test-android-installer")),
    );
    for (const url of [
      "/releases/1.0.1/server.json",
      "/releases/1.0.1/%2e%2e%2fserver.json",
      "/releases/%2e%2e/Praxis-1.0.1-android.apk",
      "/releases/1.0.2/Praxis-1.0.2-android.apk",
    ])
      expect((await app.inject({ url })).statusCode).toBe(404);
  } finally {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

it("serves the same installer manifest to clients and the authenticated admin page", async () => {
  const token = "release-manifest-test-administrator-key";
  const release = {
    version: "1.0.1",
    notes: "Windows 与 Android 安装包",
    minimumVersion: "0.1.0",
    publishedAt: "2026-11-16T00:00:00.000Z",
    windows: {
      url: "https://example.test/releases/Praxis-setup.exe",
      sha256: "a".repeat(64),
    },
    android: {
      url: "https://example.test/releases/Praxis.apk",
      sha256: "b".repeat(64),
    },
  };
  const app = createServer({
    databasePath: ":memory:",
    devices: [],
    release,
    adminTokenHash: createHash("sha256").update(token).digest("hex"),
  });
  try {
    expect((await app.inject({ url: "/admin/api/release" })).statusCode).toBe(
      401,
    );
    const login = await app.inject({
      method: "POST",
      url: "/admin/api/login",
      headers: { "x-praxis-admin": "1" },
      payload: { token },
    });
    expect(login.statusCode).toBe(200);
    const result = await app.inject({
      url: "/admin/api/release",
      headers: { cookie: String(login.headers["set-cookie"]).split(";")[0]! },
    });
    expect(result.statusCode).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.json()).toEqual(release);
    expect((await app.inject({ url: "/app/release" })).json()).toEqual(release);
  } finally {
    await app.close();
  }
});
