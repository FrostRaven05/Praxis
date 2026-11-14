import { invoke, isTauri } from "@tauri-apps/api/core";

export const DEFAULT_THEME_COLOR = "#A6D6C3";
const LEGACY_DEFAULT_THEME_COLOR = "#BDE7EE";
export const THEME_COLORS = [
  { name: "青玉", color: DEFAULT_THEME_COLOR, foreground: "#2E7A64" },
  { name: "朱砂", color: "#D1453B", foreground: "#D1453B" },
  { name: "金丹", color: "#E8C77A", foreground: "#8A6414" },
  { name: "紫府", color: "#C8BDE8", foreground: "#7B60AE" },
];
const key = "praxis.theme.color";
let current = DEFAULT_THEME_COLOR;
const listeners = new Set<() => void>();
export const subscribeTheme = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
export const getThemeColor = () => current;
export function normalizeThemeColor(value: string) {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error("请选择有效的颜色。");
  return value.toUpperCase();
}
function rgb(color: string) {
  return [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
}
function hex(values: number[]) {
  return (
    "#" +
    values
      .map((v) => Math.round(v).toString(16).padStart(2, "0"))
      .join("")
      .toUpperCase()
  );
}
function mix(color: string, target: string, amount: number) {
  const to = rgb(target);
  return hex(rgb(color).map((v, i) => v * (1 - amount) + to[i]! * amount));
}
function luminance(color: string) {
  const values = rgb(color).map((v) => {
    const n = v / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  });
  return values[0]! * 0.2126 + values[1]! * 0.7152 + values[2]! * 0.0722;
}
export function colorContrast(a: string, b: string) {
  const [light, dark] = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (light! + 0.05) / (dark! + 0.05);
}
function readable(color: string, background: string, target: string) {
  for (let step = 0; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (colorContrast(candidate, background) >= 4.5) return candidate;
  }
  return target;
}
export function themeColorTokens(value: string) {
  const color = normalizeThemeColor(value);
  const foregroundColor =
    THEME_COLORS.find((theme) => theme.color === color)?.foreground ??
    readable(color, "#FFFFFF", "#0D0D0D");
  const dark =
    color === "#D1453B" ? "#F28D82" : readable(color, "#2F2F2F", "#FFFFFF");
  const foreground = (accent: string) =>
    colorContrast(accent, "#FFFFFF") >= colorContrast(accent, "#111111")
      ? "#FFFFFF"
      : "#111111";
  return {
    "--primary-light": color,
    "--primary-light-hover":
      color === "#D1453B" ? "#B8382F" : mix(color, "#111111", 0.12),
    "--primary-dark": dark,
    "--primary-dark-hover":
      color === "#D1453B" ? "#FFA399" : mix(dark, "#FFFFFF", 0.12),
    "--primary-light-text": foregroundColor,
    "--primary-dark-text": readable(dark, "#2F2F2F", "#FFFFFF"),
    "--on-primary-light": foreground(color),
    "--on-primary-inverse": foreground(dark),
  };
}
function apply(value: string) {
  current = normalizeThemeColor(value);
  if (current === LEGACY_DEFAULT_THEME_COLOR) current = DEFAULT_THEME_COLOR;
  for (const [name, token] of Object.entries(themeColorTokens(current)))
    document.documentElement.style.setProperty(name, token);
  document.documentElement.dataset.themeColor = current;
  try {
    localStorage.setItem(key, current);
  } catch {
    /* Native preferences remain authoritative. */
  }
  listeners.forEach((listener) => listener());
}
export async function initializeTheme() {
  let color = DEFAULT_THEME_COLOR;
  try {
    color = localStorage.getItem(key) ?? color;
  } catch {
    /* Use the default if browser storage is unavailable. */
  }
  if (isTauri()) {
    try {
      color = (await invoke<{ color: string }>("read_theme_color")).color;
    } catch {
      /* Keep a cached preference when native reading is unavailable. */
    }
  }
  try {
    apply(color);
  } catch {
    apply(DEFAULT_THEME_COLOR);
  }
}
export async function setThemeColor(value: string) {
  const color = normalizeThemeColor(value);
  if (isTauri()) await invoke("save_theme_color", { color });
  else localStorage.setItem(key, color);
  apply(color);
}
