import { expect, it } from "vitest";
import {
  colorContrast,
  THEME_COLORS,
  normalizeThemeColor,
  themeColorTokens,
} from "./theme-preferences";

it("keeps arbitrary accents while making their text readable in light and dark modes", () => {
  for (const color of [
    "#BDE7EE",
    "#D1453B",
    "#ADD8C6",
    "#C8BDE8",
    "#FFFFFF",
    "#000000",
    "#123456",
  ]) {
    const tokens = themeColorTokens(color);
    expect(tokens["--primary-light"]).toBe(color);
    expect(
      colorContrast(tokens["--primary-light-text"], "#FFFFFF"),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      colorContrast(tokens["--primary-dark-text"], "#2F2F2F"),
    ).toBeGreaterThanOrEqual(4.5);
    expect(
      colorContrast(color, tokens["--on-primary-light"]),
    ).toBeGreaterThanOrEqual(4.5);
  }
  expect(themeColorTokens("#D1453B")["--primary-dark"]).toBe("#F28D82");
});
it("uses the same stronger foreground for each preset's text, icons and outlines", () => {
  expect(THEME_COLORS.map((theme) => theme.name)).toEqual([
    "青玉",
    "朱砂",
    "金丹",
    "紫府",
  ]);
  for (const theme of THEME_COLORS) {
    expect(themeColorTokens(theme.color)["--primary-light-text"]).toBe(
      theme.foreground,
    );
    expect(colorContrast(theme.foreground, "#F9F9F9")).toBeGreaterThanOrEqual(
      4,
    );
  }
});
it("normalizes hex values and rejects malformed preferences", () => {
  expect(normalizeThemeColor("#bde7ee")).toBe("#BDE7EE");
  for (const color of ["blue", "#123", "#GGGGGG", "#12345678", "#12345;"])
    expect(() => normalizeThemeColor(color)).toThrow();
});
