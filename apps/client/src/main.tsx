import { TitleBar } from "./TitleBar";
import { isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isMobileSurface } from "./mobile-surface";
import { lazy, Suspense } from "react";
import "./theme.css";
import "./styles.css";
import "./compact.css";
import "./components.css";
import "./interface.css";
import "./reference.css";
import "./todoist.css";
import "./date-picker.css";
import "./project-workspace.css";
import "./project-board.css";
import "./project-gantt.css";
import "./content.css";
import "./modern.css";
import "./polish.css";
import "./redesign.css";
import "./game.css";
import "./xiuxian.css";
import "./pomodoro.css";
import { initializeTheme } from "./theme-preferences";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const MobileApp = lazy(() =>
  import("./mobile/MobileApp").then((module) => ({
    default: module.MobileApp,
  })),
);
void initializeTheme().then(() =>
  createRoot(root).render(
    <StrictMode>
      {isTauri() ? (
        <div className="desktop-shell">
          <TitleBar />
          <App />
        </div>
      ) : isMobileSurface() ? (
        <Suspense fallback={<p role="status">正在打开本机工作空间…</p>}>
          <MobileApp />
        </Suspense>
      ) : (
        <App />
      )}
    </StrictMode>,
  ),
);
