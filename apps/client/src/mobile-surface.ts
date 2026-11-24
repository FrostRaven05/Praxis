import { Capacitor } from "@capacitor/core";
import { isTauri } from "./native-recovery";

/** True only when explicitly previewing the mobile UI in a regular web browser. */
export function isMobilePreview(): boolean {
  if (isTauri() || Capacitor.isNativePlatform()) return false;
  if (typeof window === "undefined") return false;
  try {
    return new URLSearchParams(window.location.search).get("surface") === "mobile";
  } catch {
    return false;
  }
}

export function isMobileSurface(): boolean {
  return Capacitor.isNativePlatform() || isMobilePreview();
}
