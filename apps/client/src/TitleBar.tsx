import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
export function TitleBar() {
  const [maximized, setMaximized] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    let unlisten: (() => void) | undefined;
    const window = getCurrentWindow();
    const update = () => {
      void window
        .isMaximized()
        .then((value) => {
          if (active) setMaximized(value);
        })
        .catch(() => {});
    };
    update();
    void window
      .onResized(update)
      .then((off) => {
        if (active) unlisten = off;
        else off();
      })
      .catch(() => {});
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);
  async function act(action: "minimize" | "toggleMaximize" | "close") {
    setError("");
    try {
      await getCurrentWindow()[action]();
      if (action === "toggleMaximize")
        setMaximized(await getCurrentWindow().isMaximized());
    } catch {
      setError("窗口操作未成功，请重试。");
    }
  }
  return (
    <header className="window-titlebar" aria-label="窗口标题栏">
      <div
        className="window-drag-region"
        data-tauri-drag-region
        title="拖动窗口，双击最大化或还原"
      />
      <div className="window-controls">
        <button
          aria-label="最小化窗口"
          title="最小化"
          onClick={() => void act("minimize")}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="M1 6h10" />
          </svg>
        </button>
        <button
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
          title={maximized ? "还原" : "最大化"}
          onClick={() => void act("toggleMaximize")}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            {maximized ? (
              <path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7z" />
            ) : (
              <rect x="1.5" y="1.5" width="9" height="9" />
            )}
          </svg>
        </button>
        <button
          className="window-close"
          aria-label="关闭窗口"
          title="关闭"
          onClick={() => void act("close")}
        >
          <svg viewBox="0 0 12 12" aria-hidden="true">
            <path d="m1.5 1.5 9 9m0-9-9 9" />
          </svg>
        </button>
      </div>
      {error && (
        <p className="window-error" role="alert">
          {error}
        </p>
      )}
    </header>
  );
}
