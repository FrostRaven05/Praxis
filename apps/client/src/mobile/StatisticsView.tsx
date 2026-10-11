import { useState } from "react";
import type { WorkspaceEntity } from "@praxis/storage-mobile";
import {
  dayMetrics,
  finitePositive,
  shiftDay,
  timestampDay,
} from "./mobile-dashboard-model";
import { MobileNavIcon } from "./MobileNavIcon";
import "./mobile-dashboard.css";

export function StatisticsView({
  entities,
  today,
  timeZone,
  onReview,
}: {
  entities: WorkspaceEntity[];
  today: string;
  timeZone: string;
  onReview: () => void;
}) {
  const [tab, setTab] = useState("yesterday");
  const yesterday = shiftDay(today, -1);
  const weekStart = shiftDay(
    today,
    -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7),
  );
  const dates = Array.from({ length: tab === "yesterday" ? 8 : 7 }, (_, i) =>
    shiftDay(
      tab === "week"
        ? weekStart
        : tab === "yesterday"
          ? shiftDay(yesterday, -7)
          : shiftDay(today, -6),
      i,
    ),
  );
  const metrics = dates.map((date) => dayMetrics(entities, date, timeZone));
  const yesterdayMetrics = dayMetrics(entities, yesterday, timeZone);
  const total =
    tab === "yesterday"
      ? yesterdayMetrics
      : metrics.reduce(
          (sum, item) => ({
            completed: sum.completed + item.completed,
            focusSeconds: sum.focusSeconds + item.focusSeconds,
            estimatedMinutes: sum.estimatedMinutes + item.estimatedMinutes,
            sessions: sum.sessions + item.sessions,
            tasks: [...sum.tasks, ...item.tasks],
          }),
          {
            completed: 0,
            focusSeconds: 0,
            estimatedMinutes: 0,
            sessions: 0,
            tasks: [] as WorkspaceEntity[],
          },
        );
  const values = metrics.map((m) =>
    tab === "focus" ? Math.round(m.focusSeconds / 60) : m.completed,
  );
  const maximum = Math.max(2, Math.ceil(Math.max(...values) / 2) * 2);
  const points = values.map(
    (value, index) =>
      `${32 + index * (276 / (values.length - 1))},${142 - (value / maximum) * 106}`,
  );
  const period =
    tab === "yesterday" ? "昨天" : tab === "week" ? "本周" : "近七天";
  const focusRecords = entities
    .filter(
      (e) =>
        !e.deleted &&
        e.kind === "focus" &&
        !!e.data.endedAt &&
        dates.includes(timestampDay(e.data.startedAt, timeZone) || ""),
    )
    .sort((a, b) =>
      String(b.data.startedAt).localeCompare(String(a.data.startedAt)),
    );
  return (
    <div className="pm-statistics">
      <div className="pm-stat-tabs" role="tablist" aria-label="统计视图">
        {[
          ["yesterday", "昨日小结", "history"],
          ["tasks", "任务统计", "tasks"],
          ["focus", "专注统计", "focus"],
          ["week", "周报", "stats"],
        ].map(([key, label, icon]) => (
          <button
            key={key}
            role="tab"
            id={`pm-stat-tab-${key}`}
            aria-controls="pm-stat-content"
            aria-selected={tab === key}
            tabIndex={tab === key ? 0 : -1}
            onKeyDown={(event) => {
              const keys = ["yesterday", "tasks", "focus", "week"];
              const index = keys.indexOf(tab);
              const next =
                event.key === "ArrowRight"
                  ? keys[(index + 1) % 4]
                  : event.key === "ArrowLeft"
                    ? keys[(index + 3) % 4]
                    : event.key === "Home"
                      ? keys[0]
                      : event.key === "End"
                        ? keys[3]
                        : undefined;
              if (next) {
                event.preventDefault();
                setTab(next);
                document.getElementById(`pm-stat-tab-${next}`)?.focus();
              }
            }}
            onClick={() => setTab(key!)}
          >
            <MobileNavIcon
              name={icon as "history" | "tasks" | "focus" | "stats"}
            />
            {label}
          </button>
        ))}
      </div>
      <section
        role="tabpanel"
        id="pm-stat-content"
        aria-labelledby={`pm-stat-tab-${tab}`}
      >
        <p className="pm-stat-period">
          {period} ·{" "}
          {tab === "yesterday" ? yesterday : `${dates[0]} — ${dates.at(-1)}`}
        </p>
        <div className="pm-stat-cards">
          <article>
            <span>完成任务</span>
            <strong>
              {total.completed}
              <small>项</small>
            </strong>
            <p>
              {total.estimatedMinutes
                ? `合计预估 ${total.estimatedMinutes} 分钟`
                : "尚未记录预估工作量"}
            </p>
          </article>
          <article>
            <span>专注时长</span>
            <strong>
              {Math.floor(total.focusSeconds / 60)}
              <small>分钟</small>
            </strong>
            <p>{total.sessions} 次已结束专注</p>
          </article>
        </div>
        <article className="pm-stat-insight">
          <MobileNavIcon name="tasks" />
          <p>
            {period}完成了 <b>{total.completed}</b> 项任务，记录了{" "}
            <b>{Math.floor(total.focusSeconds / 60)}</b> 分钟专注。
            {total.completed || total.sessions
              ? "每一次推进都清晰可见。"
              : "完成任务后，进度会显示在这里。"}
          </p>
        </article>
        <article className="pm-chart-card">
          <h3>{tab === "focus" ? "专注时长趋势" : "任务完成趋势"}</h3>
          <p>
            {tab === "week" ? "本周" : `近 ${dates.length} 天`} ·{" "}
            {tab === "focus" ? "分钟" : "项"}
          </p>
          <svg
            className="pm-stat-chart"
            viewBox="0 0 340 185"
            role="img"
            aria-label={dates
              .map(
                (date, i) =>
                  `${date}：${values[i]} ${tab === "focus" ? "分钟" : "项"}`,
              )
              .join("；")}
          >
            {[0, 0.5, 1].map((ratio) => (
              <g key={ratio}>
                <line
                  x1="32"
                  x2="308"
                  y1={142 - ratio * 106}
                  y2={142 - ratio * 106}
                  stroke="var(--line)"
                  strokeDasharray="3 5"
                />
                <text x="23" y={146 - ratio * 106} textAnchor="end">
                  {Number((maximum * ratio).toFixed(1))}
                </text>
              </g>
            ))}
            <polygon
              points={`32,142 ${points.join(" ")} 308,142`}
              fill="var(--selected)"
            />
            <polyline
              points={points.join(" ")}
              fill="none"
              stroke="var(--primary-text)"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            {values.map((value, i) => (
              <g key={dates[i]}>
                <circle
                  cx={32 + (i * 276) / (values.length - 1)}
                  cy={142 - (value / maximum) * 106}
                  r="3"
                  fill="var(--primary-text)"
                />
                <text
                  x={32 + (i * 276) / (values.length - 1)}
                  y="170"
                  textAnchor="middle"
                >
                  {dates[i]!.slice(5).replace("-", ".")}
                </text>
              </g>
            ))}
          </svg>
        </article>
        {tab === "week" && (
          <button className="pm-review-link" onClick={onReview}>
            写周回顾 <span aria-hidden="true">›</span>
          </button>
        )}
        <article className="pm-stat-list">
          <h3>
            {tab === "focus" ? `${period}专注记录` : `${period}完成的任务`}
          </h3>
          {tab === "focus" ? (
            focusRecords.length ? (
              focusRecords.map((session) => (
                <div key={session.id}>
                  <span>{String(session.data.title || "自由专注")}</span>
                  <small>
                    {Math.floor(
                      finitePositive(session.data.durationSeconds) / 60,
                    )}{" "}
                    分钟
                  </small>
                </div>
              ))
            ) : (
              <p className="mx-muted">暂无专注记录</p>
            )
          ) : total.tasks.length ? (
            total.tasks.map((task) => (
              <div key={task.id}>
                <span>{String(task.data.title || "未命名任务")}</span>
                <small>已完成</small>
              </div>
            ))
          ) : (
            <p className="mx-muted">暂无完成记录</p>
          )}
        </article>
        <p className="pm-stat-note">
          根据已保存的完成日期与已结束专注统计。预估工作量不代表实际用时。
        </p>
      </section>
    </div>
  );
}
