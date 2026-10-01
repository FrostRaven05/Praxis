import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("leaves Windows HTML drag/drop to the page instead of the native file-drop handler", () => {
  // CDP drag tests bypass the Windows OLE handler, so they cannot catch this
  // desktop-only regression. Tauri enables the conflicting handler by default.
  const config = JSON.parse(
    readFileSync("apps/desktop/src-tauri/tauri.conf.json", "utf8"),
  );
  for (const window of config.app.windows) {
    expect(window.dragDropEnabled).toBe(false);
  }
});
