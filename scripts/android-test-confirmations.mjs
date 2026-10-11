import { execFileSync } from "node:child_process";
import { join } from "node:path";
// CDP can resolve window.confirm without dismissing the Android WebView alert UI.
export function dismissTestConfirmation(stamp) {
  const adbPath = join(
    process.env.LOCALAPPDATA,
    "Android/Sdk/platform-tools/adb.exe",
  );
  const adb = (...args) =>
    execFileSync(adbPath, ["-s", "emulator-5554", ...args], {
      encoding: "utf8",
    });
  const path = "/sdcard/praxis-inbox-check.xml";
  try {
    adb("shell", "uiautomator", "dump", path);
    const xml = adb("shell", "cat", path);
    const nodes = [...xml.matchAll(/<node\b[^>]*>/g)].map((match) =>
      Object.fromEntries(
        [...match[0].matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]),
      ),
    );
    const message = nodes.find(
      (n) => n["resource-id"] === "android:id/message",
    );
    if (!message) return;
    if (
      !message.text.includes(`面板验收 ${stamp} `) ||
      !message.text.includes("移到回收站")
    )
      throw new Error("Unrelated native confirmation: left untouched");
    const button = nodes.find((n) => n["resource-id"] === "android:id/button1");
    if (!button) throw new Error("Native confirmation button missing");
    const bounds = [...button.bounds.matchAll(/\d+/g)].map((m) => Number(m[0]));
    adb(
      "shell",
      "input",
      "tap",
      String(Math.round((bounds[0] + bounds[2]) / 2)),
      String(Math.round((bounds[1] + bounds[3]) / 2)),
    );
  } finally {
    adb("shell", "rm", path);
  }
}
