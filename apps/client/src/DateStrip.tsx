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
  const weekdays = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
  const shortWeekdays = ["日", "一", "二", "三", "四", "五", "六"];
  const weekday = weekdays[value.getUTCDay()];
  const label = `${value.getUTCMonth() + 1}月${value.getUTCDate()}日 ${weekday}`;
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
            const itemDate = new Date(item + "T12:00:00Z");
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
                <span className="date-strip-weekday" aria-hidden="true">
                  {shortWeekdays[itemDate.getUTCDay()]}
                </span>
                <span className="date-strip-number">{item.slice(-2)}</span>
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
        disabled={disabled || date === today}
        aria-label="回到今天"
        onClick={() => onSelect(today)}
      >
        今天
      </button>
    </div>
  );
}
