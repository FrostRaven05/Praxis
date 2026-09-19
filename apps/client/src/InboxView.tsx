import { TaskDetailsButton } from "./TaskDetailsButton";
import { ProjectAssignment } from "./ProjectAssignment";
import { useEffect, useState } from "react";
import { calendarDate, type InboxTask } from "@praxis/application";
import { planningStorage } from "./storage";
import { planning } from "./PlanningPanel";
export function InboxView({
  onScheduled,
}: {
  onScheduled: (date: string) => void;
}) {
  const [tasks, setTasks] = useState<InboxTask[]>([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [date, setDate] = useState(() =>
    calendarDate(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  const refresh = async () => {
    try {
      setTasks(await planningStorage.listInbox());
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  useEffect(() => {
    void refresh();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    return () => window.removeEventListener("focus", focus);
  }, []);
  return (
    <section className="today inbox-view" aria-labelledby="inbox-heading">
      <header className="topbar">
        我的工作台 / 收件箱<span className="local-badge">保存在本机</span>
      </header>
      <div className="today-content">
        <p className="eyebrow">CAPTURE NOW, PLAN LATER</p>
        <h1 id="inbox-heading">先记下来，稍后安排。</h1>
        <p className="intro">这里的任务尚未安排日期。</p>
        <form
          className="capture-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (busy) return;
            setBusy(true);
            setError("");
            void planning
              .capture(title)
              .then(async () => {
                setTitle("");
                setNotice("已保存到收件箱");
                await refresh();
              })
              .catch((e) =>
                setError(e instanceof Error ? e.message : String(e)),
              )
              .finally(() => setBusy(false));
          }}
        >
          <input
            aria-label="收件箱任务标题"
            autoFocus
            value={title}
            disabled={busy}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="记下脑海中的下一件事"
          />
          <button className="add-button" disabled={busy}>
            存入收件箱
          </button>
        </form>
        <p role="status" className="save-notice">
          {notice}
        </p>
        <div className="date-navigation">
          <label htmlFor="inbox-date">安排到</label>
          <input
            id="inbox-date"
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="error">
            {error}
            <button
              onClick={() => {
                void refresh();
              }}
            >
              重新读取收件箱
            </button>
          </p>
        )}
        <ul className="task-list">
          {tasks.map((task) => (
            <li className="inbox-row" key={task.taskId}>
              <div>
                <span>
                  {task.important && (
                    <span className="task-important">重要</span>
                  )}
                  {task.title}
                </span>
                <ProjectAssignment task={task} onAssigned={refresh} />
                <TaskDetailsButton
                  taskId={task.taskId}
                  onSaved={refresh}
                  disabled={busy}
                />
              </div>
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  setError("");
                  void planning
                    .schedule(
                      task,
                      date,
                      Intl.DateTimeFormat().resolvedOptions().timeZone,
                    )
                    .then(() => onScheduled(date))
                    .catch((e) => setError(String(e)))
                    .finally(() => setBusy(false));
                }}
              >
                安排任务
              </button>
            </li>
          ))}
        </ul>
        {!tasks.length && !error && (
          <p className="empty-state">收件箱是空的，随时记下新想法。</p>
        )}
      </div>
    </section>
  );
}
