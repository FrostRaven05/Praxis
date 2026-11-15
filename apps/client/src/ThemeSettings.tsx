import { useState, useSyncExternalStore, type CSSProperties } from "react";
import "./theme-settings.css";
import {
  DEFAULT_THEME_COLOR,
  THEME_COLORS,
  getThemeColor,
  setThemeColor,
  subscribeTheme,
} from "./theme-preferences";

export function ThemeSettings() {
  const color = useSyncExternalStore(
    subscribeTheme,
    getThemeColor,
    getThemeColor,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function choose(value: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await setThemeColor(value);
    } catch {
      setError("主题颜色暂未保存，请重试。");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="settings-card theme-settings"
      aria-labelledby="theme-heading"
    >
      <header className="settings-card-heading">
        <div>
          <h2 id="theme-heading">主题颜色</h2>
        </div>
      </header>
      <div
        className="theme-color-options"
        role="radiogroup"
        aria-label="主题颜色"
        aria-busy={busy}
      >
        {THEME_COLORS.map((theme) => (
          <button
            key={theme.color}
            type="button"
            role="radio"
            aria-checked={color === theme.color}
            disabled={busy}
            onClick={() => {
              void choose(theme.color);
            }}
            style={{ "--swatch-color": theme.color } as CSSProperties}
          >
            <span className="theme-swatch" aria-hidden="true" />
            <span>{theme.name}</span>
            {color === theme.color && (
              <span className="theme-choice-check" aria-hidden="true">
                ✓
              </span>
            )}
          </button>
        ))}
      </div>
      <div className="theme-custom-color">
        <label htmlFor="theme-custom-color">自定义颜色</label>
        <input
          id="theme-custom-color"
          type="color"
          value={color}
          disabled={busy}
          onChange={(event) => {
            void choose(event.target.value);
          }}
        />
        <span className="theme-color-value">{color}</span>
        <button
          type="button"
          disabled={busy || color === DEFAULT_THEME_COLOR}
          onClick={() => {
            void choose(DEFAULT_THEME_COLOR);
          }}
        >
          恢复青玉
        </button>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : (
        <p className="theme-status" role="status">
          {busy ? "正在保存…" : "自动保存，重启后仍会保留。"}
        </p>
      )}
    </section>
  );
}
