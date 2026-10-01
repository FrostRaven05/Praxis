import { DatePicker } from "./DatePicker";
import { shiftCalendarDate as shiftDate } from "./calendar-controls";

export function DateStrip({
  date,
  today,
  onSelect,
  disabled = false,
}: {
  date: string;
  today: string;
  onSelect: (date: string) => void;
  disabled?: boolean;
}) {
  const value = new Date(date + "T12:00:00Z");
  const monday = shiftDate(date, -((value.getUTCDay() + 6) % 7));
  const label = `${value.getUTCMonth() + 1}月${value.getUTCDate()}日 ${date === today ? "今天" : ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][value.getUTCDay()]}`;
  return (
    <div className="date-strip-row">
      <nav className="date-strip" aria-label="日期导航">
        <button
          className="date-strip-arrow"
          aria-label="上一周"
          disabled={disabled}
          onClick={() => onSelect(shiftDate(date, -7))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m14 6-6 6 6 6" />
          </svg>
        </button>
        <div className="date-strip-days">
          {Array.from({ length: 7 }, (_, index) => {
            const item = shiftDate(monday, index);
            return (
              <button
                key={item}
                disabled={disabled}
                className={`date-strip-day${item === date ? " is-selected" : ""}${item === today ? " is-today" : ""}`}
                aria-label={`${item}${item === today ? " 今天" : ""}`}
                aria-pressed={item === date}
                aria-current={item === today ? "date" : undefined}
                onClick={() => onSelect(item)}
              >
                {item === today ? "今" : Number(item.slice(-2))}
              </button>
            );
          })}
        </div>
        <button
          className="date-strip-arrow"
          aria-label="下一周"
          disabled={disabled}
          onClick={() => onSelect(shiftDate(date, 7))}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m10 6 6 6-6 6" />
          </svg>
        </button>
        <DatePicker
          className="date-strip-label"
          label="查看日期"
          display={label}
          value={date}
          today={today}
          disabled={disabled}
          onChange={onSelect}
        />
      </nav>
      <button
        className="date-strip-today"
        title="回到今天"
        disabled={disabled}
        aria-label="回到今天"
        onClick={() => onSelect(today)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
          <path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" />
        </svg>
      </button>
    </div>
  );
}
