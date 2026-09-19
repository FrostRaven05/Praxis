import { TitleBar } from "./TitleBar";
import { isTauri } from "@tauri-apps/api/core";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./theme.css";
import "./styles.css";
import "./compact.css";
import "./components.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    {isTauri() ? (
      <div className="desktop-shell">
        <TitleBar />
        <App />
      </div>
    ) : (
      <App />
    )}
  </StrictMode>,
);
