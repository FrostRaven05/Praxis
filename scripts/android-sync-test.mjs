// Restart the native app, not its WebView: native SQLite connections outlive page reloads.
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
export async function restartAndroidForSyncTest() {
  const executable = join(
    process.env.LOCALAPPDATA,
    "Android/Sdk/platform-tools/adb.exe",
  );
  const adb = (...args) =>
    execFileSync(executable, ["-s", "emulator-5554", ...args], {
      encoding: "utf8",
      windowsHide: true,
    }).trim();
  adb("shell", "am", "force-stop", "com.praxis.mobile");
  adb("shell", "am", "start", "-n", "com.praxis.mobile/.MainActivity");
  for (let i = 0; i < 80; i++) {
    let pid = "";
    try {
      pid = adb("shell", "pidof", "com.praxis.mobile");
    } catch {}
    if (pid) {
      adb(
        "forward",
        "tcp:9223",
        `localabstract:webview_devtools_remote_${pid}`,
      );
      try {
        const pages = await fetch("http://127.0.0.1:9223/json/list").then((r) =>
          r.json(),
        );
        if (pages.length) return;
      } catch {}
    }
    await delay(250);
  }
  throw Error("Android app WebView did not start within 20 seconds");
}
