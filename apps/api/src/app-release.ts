export interface ReleaseAsset {
  url: string;
  sha256: string;
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
    publishedAt: row.publishedAt == null ? null : new Date(row.publishedAt).toISOString(),
    minimumVersion: row.minimumVersion,
    windows: asset(row.windows),
    android: asset(row.android),
  };
}
