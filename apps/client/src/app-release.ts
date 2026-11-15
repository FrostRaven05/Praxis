export type ReleasePlatform = "windows" | "android";
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
const version = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})$/;
export function compareVersions(left: string, right: string): -1 | 0 | 1 | null {
  const a = version.exec(left);
  const b = version.exec(right);
  if (!a || !b) return null;
  for (let i = 1; i <= 3; i += 1) {
    const delta = Number(a[i]) - Number(b[i]);
    if (delta !== 0) return delta < 0 ? -1 : 1;
  }
  return 0;
}
function httpsUrl(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}
export function releaseOffer(
  current: string,
  release: AppRelease,
  platform: ReleasePlatform,
) {
  const newer = compareVersions(current, release.version);
  const floor = compareVersions(current, release.minimumVersion);
  if (newer === null || floor === null) return { state: "unknown" as const };
  const asset = release[platform];
  const url = asset && httpsUrl(asset.url) ? asset.url : null;
  if (newer < 0 || floor < 0)
    return {
      state: "update" as const,
      required: floor < 0,
      version: release.version,
      notes: release.notes,
      url,
    };
  return { state: "current" as const };
}
