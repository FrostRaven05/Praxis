import { createReadStream, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FastifyInstance } from "fastify";

export interface ReleaseAsset {
  url: string;
  sha256: string;
}

export function registerReleaseDownloads(
  app: FastifyInstance,
  directory?: string,
) {
  app.get<{ Params: { version: string; file: string } }>(
    "/releases/:version/:file",
    async (request, reply) => {
      const { version: requestedVersion, file } = request.params;
      const platform =
        file === `Praxis-${requestedVersion}-windows-x64-setup.exe`
          ? "windows"
          : file === `Praxis-${requestedVersion}-android.apk`
            ? "android"
            : null;
      if (!directory || !version.test(requestedVersion) || !platform)
        return reply.code(404).send({ error: "RELEASE_NOT_FOUND" });
      let path: string;
      let size: number;
      try {
        const root = realpathSync(directory);
        path = realpathSync(join(root, requestedVersion, file));
        if (dirname(path) !== join(root, requestedVersion))
          return reply.code(404).send({ error: "RELEASE_NOT_FOUND" });
        const stat = statSync(path);
        if (!stat.isFile())
          return reply.code(404).send({ error: "RELEASE_NOT_FOUND" });
        size = stat.size;
      } catch {
        return reply.code(404).send({ error: "RELEASE_NOT_FOUND" });
      }
      return reply
        .type(
          platform === "android"
            ? "application/vnd.android.package-archive"
            : "application/vnd.microsoft.portable-executable",
        )
        .header("Content-Disposition", `attachment; filename="${file}"`)
        .header("Content-Length", size)
        .header("Cache-Control", "public, max-age=86400, immutable")
        .header("X-Content-Type-Options", "nosniff")
        .send(createReadStream(path));
    },
  );
}
export interface AppRelease {
  version: string;
  notes: string;
  publishedAt: string | null;
  minimumVersion: string;
  windows: ReleaseAsset | null;
  android: ReleaseAsset | null;
}
const version = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;
export const currentAppRelease: AppRelease = {
  version: "0.1.0",
  notes: "",
  publishedAt: null,
  minimumVersion: "0.1.0",
  windows: null,
  android: null,
};
function asset(value: unknown): ReleaseAsset | null {
  if (value == null) return null;
  if (!value || typeof value !== "object") throw new Error("invalid_release");
  const row = value as Record<string, unknown>;
  if (typeof row.url !== "string" || typeof row.sha256 !== "string")
    throw new Error("invalid_release");
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    throw new Error("invalid_release");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !/^[a-f0-9]{64}$/.test(row.sha256)
  )
    throw new Error("invalid_release");
  return { url: url.toString(), sha256: row.sha256 };
}
export function readRelease(value: unknown): AppRelease {
  if (value == null) return currentAppRelease;
  if (!value || typeof value !== "object") throw new Error("invalid_release");
  const row = value as Record<string, unknown>;
  if (
    typeof row.version !== "string" ||
    !version.test(row.version) ||
    typeof row.minimumVersion !== "string" ||
    !version.test(row.minimumVersion) ||
    typeof row.notes !== "string" ||
    row.notes.length > 4000 ||
    (row.publishedAt != null &&
      (typeof row.publishedAt !== "string" ||
        Number.isNaN(Date.parse(row.publishedAt))))
  )
    throw new Error("invalid_release");
  return {
    version: row.version,
    notes: row.notes,
    publishedAt:
      row.publishedAt == null ? null : new Date(row.publishedAt).toISOString(),
    minimumVersion: row.minimumVersion,
    windows: asset(row.windows),
    android: asset(row.android),
  };
}
