import type { WorkspaceEntity } from "@praxis/storage-mobile";
import { calendarTasks, monthDays, shiftMonth } from "./mobile-dashboard-model";
import "./mobile-dashboard.css";

export function MonthCalendar({
  date,
  today,
  entities,
  onChoose,
}: {
  date: string;
  today: string;
  entities: WorkspaceEntity[];
  onChoose: (date: string) => void;
}) {
  const days = monthDays(date);
  return (
    <section className="pm-month-calendar" aria-label="月历">
      <div className="pm-month-toolbar">
        <button
          aria-label="上个月"
          onClick={() => onChoose(shiftMonth(date, -1))}
        >
          ‹
        </button>
        <label>
          <span>
            {Number(date.slice(0, 4))}年{Number(date.slice(5, 7))}月
          </span>
          <input
            aria-label="跳转月份"
            type="month"
            value={date.slice(0, 7)}
            onChange={(e) => {
              if (e.target.value) onChoose(`${e.target.value}-01`);
            }}
          />
        </label>
        <button className="pm-month-today" onClick={() => onChoose(today)}>
          今天
        </button>
        <button
          aria-label="下个月"
          onClick={() => onChoose(shiftMonth(date, 1))}
        >
          ›
        </button>
      </div>
      <div className="pm-month-weekdays" aria-hidden="true">
        {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
          <span key={day}>周{day}</span>
        ))}
      </div>
      <div className="pm-month-grid">
        {days.map((day) => {
          const all = calendarTasks(entities, day);
          const roots = all.filter(
            (task) => !all.some((parent) => parent.id === task.data.parentId),
          );
          return (
            <button
              key={day}
              className={`pm-month-day${day === date ? " selected" : ""}${day.slice(0, 7) !== date.slice(0, 7) ? " outside" : ""}`}
              aria-label={`${day}${day === today ? " 今天" : ""}，${roots.length} 项任务`}
              aria-pressed={day === date}
              aria-current={day === today ? "date" : undefined}
              onClick={() => onChoose(day)}
            >
              <span
                className={
                  day === today ? "pm-month-number is-today" : "pm-month-number"
                }
              >
                {Number(day.slice(-2))}
              </span>
              <span className="pm-month-snippets">
                {roots.length > 0 && (
                  <span className="pm-month-count">{roots.length} 项</span>
                )}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
