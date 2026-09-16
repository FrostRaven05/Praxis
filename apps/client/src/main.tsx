import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="workspace">
      <aside className="sidebar">
        <a className="brand" href="#today"><span className="brand-mark">P</span>Praxis<span className="brand-dot">.</span></a>
        <p className="tagline">Turn intent into action.</p>
        <nav aria-label="主导航"><a className="nav-item active" href="#today"><span>☀</span>今日<span className="nav-shortcut">01</span></a></nav>
        <div className="sidebar-foot"><span className="status-dot" />本地工作空间</div>
      </aside>
      <section className="today" id="today" aria-labelledby="today-title">
        <header className="topbar"><span>我的工作台 / 今日</span><span className="local-badge">离线优先</span></header>
        <div className="today-content">
          <div className="heading-row"><div><p className="eyebrow">A LITTLE PROGRESS, EVERY DAY</p><h1 id="today-title">今天，从一件小事开始<span>。</span></h1></div></div>
          <p className="intro">把脑海里的下一步，变成清晰的行动。</p>
          <div className="empty-state"><span className="empty-icon">↗</span><h2>留一点空间，给重要的事</h2><p>今日任务将在这里展开。</p></div>
          <footer className="content-foot"><span>PRAXIS / TODAY</span><span>想法，正在成为行动。</span></footer>
        </div>
      </section>
    </main>
  );
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(<StrictMode><App /></StrictMode>);
