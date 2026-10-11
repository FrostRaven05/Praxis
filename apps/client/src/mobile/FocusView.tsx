import { useState } from "react";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import {
  finitePositive,
  focusElapsed,
  timestampDay,
} from "./mobile-dashboard-model";
import { MobileNavIcon } from "./MobileNavIcon";
import "./mobile-dashboard.css";

export function FocusView({
  entities,
  now,
  today,
  timeZone,
  name,
  onName,
  onStart,
  onFinish,
  onDelete,
}: {
  entities: WorkspaceEntity[];
  now: number;
  today: string;
  timeZone: string;
  name: string;
  onName: (name: string) => void;
  onStart: (title: string, taskId: string | null) => void;
  onFinish: (session: WorkspaceEntity, elapsed: number) => void;
  onDelete: (session: WorkspaceEntity) => void;
}) {
  const [taskId, setTaskId] = useState("");
  const [history, setHistory] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const sessions = entities.filter((e) => !e.deleted && e.kind === "focus");
  const active = sessions.find((e) => !e.data.endedAt);
  const tasks = entities.filter(
    (e) =>
      !e.deleted &&
      e.kind === "task" &&
      !e.data.archivedAt &&
      !["completed", "cancelled"].includes(String(e.data.status)),
  );
  const chosen = tasks.find((e) => e.id === taskId);
  const elapsed = active ? focusElapsed(active.data.startedAt, now) : 0;
  const target = active
    ? finitePositive(active.data.targetSeconds) || 1500
    : 1500;
  const remaining = Math.max(0, target - elapsed);
  const ended = sessions
    .filter((e) => e.data.endedAt)
    .sort((a, b) =>
      String(b.data.startedAt).localeCompare(String(a.data.startedAt)),
    );
  const todaySessions = ended.filter(
    (e) => timestampDay(e.data.startedAt, timeZone) === today,
  );
  const todayMinutes = Math.floor(
    todaySessions.reduce(
      (sum, e) => sum + finitePositive(e.data.durationSeconds),
      0,
    ) / 60,
  );
  return (
    <div className="pm-focus-view">
      <section className="pm-focus-select">
        <span className="pm-focus-eyebrow">一次只专注一件事</span>
        {active ? (
          <h2>{String(active.data.title || "自由专注")}</h2>
        ) : (
          <>
            <label>
              选择专注任务
              <select
                aria-label="选择专注任务"
                value={chosen?.id || ""}
                onChange={(e) => {
                  setTaskId(e.target.value);
                  onName("");
                }}
              >
                <option value="">自由专注</option>
                {tasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {String(task.data.title || "未命名任务")}
                  </option>
                ))}
              </select>
            </label>
            {!chosen && (
              <input
                aria-label="本次专注"
                placeholder="为这段时间定一个目标（可选）"
                value={name}
                onChange={(e) => onName(e.target.value)}
              />
            )}
          </>
        )}
      </section>
      <div className="pm-focus-clock" aria-label="专注倒计时">
        <svg viewBox="0 0 260 260" aria-hidden="true">
          <circle
            cx="130"
            cy="130"
            r="118"
            fill="none"
            stroke="var(--line)"
            strokeWidth="2"
            strokeDasharray="1 6"
          />
          <circle
            cx="130"
            cy="130"
            r="110"
            fill="none"
            stroke="var(--selected)"
            strokeWidth="5"
          />
          <circle
            cx="130"
            cy="130"
            r="110"
            fill="none"
            stroke="var(--primary-text)"
            strokeWidth="5"
            strokeLinecap="round"
            strokeDasharray={2 * Math.PI * 110}
            strokeDashoffset={
              2 * Math.PI * 110 * (1 - Math.min(elapsed / target, 1))
            }
            transform="rotate(-90 130 130)"
          />
        </svg>
        <div>
          <strong role="timer" aria-live="off">
            {String(Math.floor(remaining / 60)).padStart(2, "0")}:
            {String(Math.floor(remaining % 60)).padStart(2, "0")}
          </strong>
          <span>
            {active
              ? elapsed >= target
                ? "本轮已完成 · 继续计时中"
                : "正在专注"
              : "25 分钟，给自己一段完整的时间"}
          </span>
        </div>
      </div>
      <button
        className="pm-focus-primary"
        onClick={() =>
          active
            ? onFinish(active, elapsed)
            : onStart(
                chosen
                  ? String(chosen.data.title || "未命名任务")
                  : name.trim() || "自由专注",
                chosen?.id || null,
              )
        }
      >
        <MobileNavIcon name={active ? "focus" : "play"} />
        {active ? "结束并保存" : "开始专注"}
      </button>
      <p className="pm-focus-help">
        {active
          ? `已专注 ${Math.floor(elapsed / 60)} 分 ${elapsed % 60} 秒 · 离开页面后继续计时`
          : "结束后保存实际专注时长"}
      </p>
      <div className="pm-focus-summary">
        <div>
          <strong>{todaySessions.length}</strong>
          <span>今日专注</span>
        </div>
        <div>
          <strong>
            {todayMinutes}
            <small>分钟</small>
          </strong>
          <span>今日时长</span>
        </div>
      </div>
      <button
        className="pm-focus-history-toggle"
        aria-expanded={history}
        onClick={() => setHistory(!history)}
      >
        <MobileNavIcon name="history" />
        专注记录<span aria-hidden="true">{history ? "⌃" : "⌄"}</span>
      </button>
      {history && (
        <section className="pm-focus-history" aria-label="专注历史">
          {ended.length ? (
            ended.slice(0, 30).map((session) => (
              <article key={session.id}>
                <b>{String(session.data.title || "自由专注")}</b>
                <span>
                  {timestampDay(session.data.startedAt, timeZone) ||
                    "日期未记录"}{" "}
                  ·{" "}
                  {Math.floor(
                    finitePositive(session.data.durationSeconds) / 60,
                  )}{" "}
                  分钟
                </span>
                {deleting === session.id ? (
                  <div className="pm-focus-record-actions">
                    <span>移到回收站？</span>
                    <button
                      onClick={() => {
                        onDelete(session);
                        setDeleting(null);
                      }}
                    >
                      确认删除
                    </button>
                    <button onClick={() => setDeleting(null)}>取消</button>
                  </div>
                ) : (
                  <button
                    className="pm-focus-record-delete"
                    aria-label={`删除专注记录：${String(session.data.title || "自由专注")}`}
                    onClick={() => setDeleting(session.id)}
                  >
                    删除
                  </button>
                )}
              </article>
            ))
          ) : (
            <p className="mx-muted">完成第一段专注后，记录会显示在这里。</p>
          )}
        </section>
      )}
    </div>
  );
}
