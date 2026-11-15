import { useEffect, useState } from "react";
import {
  checkAppRelease,
  describeRelease,
  openAppRelease,
  releasePlatform,
} from "./app-update";

export function AppUpdate() {
  const [current, setCurrent] = useState("");
  const [text, setText] = useState("正在检查更新…");
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function check() {
    if (busy) return;
    setBusy(true);
    setUrl(null);
    try {
      const result = await checkAppRelease();
      const next = describeRelease(
        result.current,
        result.release,
        releasePlatform(),
      );
      setCurrent(result.current);
      setText(next.text);
      setUrl(next.url);
    } catch (error) {
      setText(error instanceof Error ? error.message : "暂时无法检查更新。");
      setUrl(null);
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    void check();
    // The first look at 通用 checks once. Later checks go through the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <h3 className="settings-group-title">软件更新</h3>
      <p className="settings-update-note">
        发现新版本后打开下载页面。安装由你确认，不会在使用中替换当前程序。
      </p>
      <div className="settings-rows">
        <div className="settings-row">
          <span>当前版本</span>
          <strong>{current || "…"}</strong>
        </div>
        <div className="settings-row settings-update-status">
          <span>{text}</span>
          <span className="settings-row-actions">
            {url && (
              <button
                type="button"
                className="settings-row-button"
                disabled={busy}
                onClick={() =>
                  void openAppRelease(url).catch((error) =>
                    setText(
                      error instanceof Error
                        ? error.message
                        : "无法打开下载页面。",
                    ),
                  )
                }
              >
                下载新版本
              </button>
            )}
            <button
              type="button"
              className="settings-row-button"
              disabled={busy}
              onClick={() => void check()}
            >
              {busy ? "正在检查…" : "检查更新"}
            </button>
          </span>
        </div>
      </div>
    </>
  );
}
