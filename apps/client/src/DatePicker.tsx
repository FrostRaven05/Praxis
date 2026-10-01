import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import { calendarDate, validCalendarDate } from "@praxis/application";
import { useAnchoredPopover } from "./useAnchoredPopover";
import {
  calendarMonthDays,
  calendarWeekday,
  shiftCalendarDate,
  shiftCalendarMonth,
} from "./calendar-controls";

export function DatePicker({
  value,
  onChange,
  label,
  disabled = false,
  className = "",
  display,
  today: referenceToday,
  mode = "date",
  clearable = false,
  id,
  buttonRef,
}: {
  value: string;
  onChange: (date: string) => void;
  label: string;
  disabled?: boolean;
  className?: string;
  display?: string | undefined;
  today?: string;
  mode?: "date" | "datetime";
  clearable?: boolean;
  id?: string;
  buttonRef?: (button: HTMLButtonElement | null) => void;
}) {
  const popover = useAnchoredPopover(
    disabled,
    '[data-calendar-date][tabindex="0"]',
  );
  const today =
    referenceToday ??
    calendarDate(new Date(), Intl.DateTimeFormat().resolvedOptions().timeZone);
  const selectedDate = value.slice(0, 10);
  const selectedTime = value.slice(11, 16) || "23:59";
  const caption =
    display ??
    (selectedDate === today
      ? "今天"
      : selectedDate === shiftCalendarDate(today, 1)
        ? "明天"
        : validCalendarDate(selectedDate)
          ? `${Number(selectedDate.slice(5, 7))}月${Number(selectedDate.slice(-2))}日`
          : "选择日期");
  return (
    <div className={`date-picker ${className}`}>
      <button
        ref={(button) => {
          popover.trigger.current = button;
          buttonRef?.(button);
        }}
        id={id}
        type="button"
        className="date-picker-trigger"
        aria-label={label}
        aria-description={validCalendarDate(selectedDate) ? value : undefined}
        aria-haspopup="dialog"
        aria-expanded={popover.open}
        aria-controls={popover.open ? popover.id : undefined}
        disabled={disabled}
        onClick={() => popover.setOpen(!popover.open)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <path d="M7 3v4m10-4v4M3 11h18" />
        </svg>
        <span>
          {caption}
          {mode === "datetime" && value ? ` ${selectedTime}` : ""}
        </span>
        <svg
          className="date-picker-chevron"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path d="m8 10 4 4 4-4" />
        </svg>
      </button>
      {clearable && value && (
        <button
          type="button"
          className="date-picker-clear"
          aria-label={"清除" + label}
          disabled={disabled}
          onClick={() => {
            onChange("");
            popover.close(true);
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m7 7 10 10M7 17 17 7" />
          </svg>
        </button>
      )}
      {popover.open &&
        createPortal(
          <div
            ref={popover.panel}
            id={popover.id}
            className="date-picker-popover"
            role="dialog"
            aria-label={label + "选择器"}
            style={popover.position}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                popover.close(true);
              }
            }}
          >
            <Calendar
              value={selectedDate}
              today={today}
              label={label}
              time={mode === "datetime" ? selectedTime : undefined}
              onTimeChange={(time) => {
                if (validCalendarDate(selectedDate))
                  onChange(selectedDate + "T" + time);
              }}
              onChoose={(date) => {
                onChange(date);
                popover.close(true);
              }}
            />
          </div>,
          popover.trigger.current?.closest(
            "dialog[open], .task-action-popover",
          ) ?? document.body,
        )}
    </div>
  );
}

function Calendar({
  value,
  today,
  label,
  time,
  onTimeChange,
  onChoose,
}: {
  value: string;
  today: string;
  label: string;
  time: string | undefined;
  onTimeChange: (time: string) => void;
  onChoose: (date: string) => void;
}) {
  const initial = validCalendarDate(value) ? value : today;
  const [month, setMonth] = useState(initial.slice(0, 7) + "-01");
  const [focused, setFocused] = useState(initial);
  const [selectedTime, setSelectedTime] = useState(time ?? "");
  const [showMonths, setShowMonths] = useState(false);
  const grid = useRef<HTMLTableElement>(null);
  const months = useRef<HTMLDivElement>(null);
  const focusDay = useRef(false);
  const heading = useId();
  useLayoutEffect(() => {
    if (showMonths) {
      months.current
        ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
        ?.focus();
    }
  }, [showMonths]);
  useLayoutEffect(() => {
    if (showMonths) return;
    if (focusDay.current) {
      focusDay.current = false;
      grid.current
        ?.querySelector<HTMLButtonElement>(`[data-calendar-date="${focused}"]`)
        ?.focus();
    }
  }, [focused, month, showMonths]);
  function move(date: string, focus = false) {
    if (!validCalendarDate(date)) return;
    focusDay.current = focus;
    setFocused(date);
    setMonth(date.slice(0, 7) + "-01");
  }
  function moveMonth(target: string, focus = false) {
    const delta =
      (Number(target.slice(0, 4)) - Number(focused.slice(0, 4))) * 12 +
      Number(target.slice(5, 7)) -
      Number(focused.slice(5, 7));
    move(shiftCalendarMonth(focused, delta), focus);
  }
  function navigate(event: KeyboardEvent, date: string) {
    if (
      event.nativeEvent.isComposing ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey
    )
      return;
    const next =
      event.key === "ArrowLeft"
        ? shiftCalendarDate(date, -1)
        : event.key === "ArrowRight"
          ? shiftCalendarDate(date, 1)
          : event.key === "ArrowUp"
            ? shiftCalendarDate(date, -7)
            : event.key === "ArrowDown"
              ? shiftCalendarDate(date, 7)
              : event.key === "Home"
                ? shiftCalendarDate(date, -calendarWeekday(date))
                : event.key === "End"
                  ? shiftCalendarDate(date, 6 - calendarWeekday(date))
                  : event.key === "PageUp"
                    ? shiftCalendarMonth(date, event.shiftKey ? -12 : -1)
                    : event.key === "PageDown"
                      ? shiftCalendarMonth(date, event.shiftKey ? 12 : 1)
                      : null;
    if (next) {
      event.preventDefault();
      event.stopPropagation();
      move(next, true);
    }
  }
  const dates = calendarMonthDays(month);
  function choose(date: string) {
    onChoose(time === undefined ? date : date + "T" + selectedTime);
  }
  function changeTime(next: string) {
    setSelectedTime(next);
    onTimeChange(next);
  }
  return (
    <>
      <div className="calendar-heading">
        <h3
          id={heading}
          aria-live="polite"
          aria-label={`${Number(month.slice(0, 4))}年${showMonths ? "" : `${Number(month.slice(5, 7))}月`}`}
        >
          <button
            type="button"
            className="calendar-month-toggle"
            aria-label={showMonths ? "返回日期" : "选择月份"}
            aria-expanded={showMonths}
            onClick={() => {
              focusDay.current = showMonths;
              setShowMonths(!showMonths);
            }}
          >
            {Number(month.slice(0, 4))}年
            {!showMonths && `${Number(month.slice(5, 7))}月`}
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d={showMonths ? "m8 14 4-4 4 4" : "m8 10 4 4 4-4"} />
            </svg>
          </button>
        </h3>
        <button
          type="button"
          aria-label={showMonths ? "上一年" : "上个月"}
          disabled={
            !validCalendarDate(shiftCalendarMonth(month, showMonths ? -12 : -1))
          }
          onClick={() =>
            moveMonth(shiftCalendarMonth(month, showMonths ? -12 : -1))
          }
        >
          ‹
        </button>
        <button
          type="button"
          aria-label={showMonths ? "下一年" : "下个月"}
          disabled={
            !validCalendarDate(shiftCalendarMonth(month, showMonths ? 12 : 1))
          }
          onClick={() =>
            moveMonth(shiftCalendarMonth(month, showMonths ? 12 : 1))
          }
        >
          ›
        </button>
      </div>
      {time !== undefined && !showMonths && (
        <div className="calendar-time" role="group" aria-label={label + "时分"}>
          <span>时间</span>
          <TimePart
            label={label + "小时"}
            max={23}
            value={selectedTime.slice(0, 2)}
            onChange={(hour) => changeTime(hour + selectedTime.slice(2))}
          />
          <span aria-hidden="true">:</span>
          <TimePart
            label={label + "分钟"}
            max={59}
            value={selectedTime.slice(3)}
            onChange={(minute) => changeTime(selectedTime.slice(0, 3) + minute)}
          />
        </div>
      )}
      {showMonths ? (
        <div
          ref={months}
          className="calendar-months"
          role="group"
          aria-label="选择月份"
        >
          {Array.from({ length: 12 }, (_, index) => {
            const target = `${month.slice(0, 4)}-${String(index + 1).padStart(2, "0")}-01`;
            return (
              <button
                key={index}
                type="button"
                aria-label={`${Number(month.slice(0, 4))}年${index + 1}月`}
                aria-pressed={index === Number(month.slice(5, 7)) - 1}
                onClick={() => {
                  moveMonth(target, true);
                  setShowMonths(false);
                }}
              >
                {index + 1}月
              </button>
            );
          })}
        </div>
      ) : (
        <table
          ref={grid}
          role="grid"
          aria-labelledby={heading}
          className="calendar-grid"
        >
          <thead>
            <tr>
              {["一", "二", "三", "四", "五", "六", "日"].map((day) => (
                <th key={day} abbr={"星期" + day} scope="col">
                  {day}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: dates.length / 7 }, (_, week) => (
              <tr key={week}>
                {dates.slice(week * 7, week * 7 + 7).map((date) => (
                  <td key={date} aria-selected={date === value || undefined}>
                    {validCalendarDate(date) && (
                      <button
                        type="button"
                        data-calendar-date={date}
                        className={`${date.slice(0, 7) !== month.slice(0, 7) ? "adjacent-month " : ""}${date === value ? "selected " : ""}${date === today ? "calendar-today" : ""}`}
                        aria-label={date}
                        aria-current={date === today ? "date" : undefined}
                        tabIndex={date === focused ? 0 : -1}
                        onFocus={() => setFocused(date)}
                        onClick={() => choose(date)}
                        onKeyDown={(event) => navigate(event, date)}
                      >
                        {Number(date.slice(-2))}
                      </button>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

function TimePart({
  label,
  value,
  max,
  onChange,
}: {
  label: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (document.activeElement !== input.current) setDraft(value);
  }, [value]);
  return (
    <input
      ref={input}
      type="number"
      inputMode="numeric"
      aria-label={label}
      min={0}
      max={max}
      step={1}
      value={draft}
      onFocus={(event) => event.currentTarget.select()}
      onChange={(event) => {
        const next = event.target.value;
        setDraft(next);
        if (/^\d{1,2}$/.test(next) && Number(next) <= max)
          onChange(next.padStart(2, "0"));
      }}
      onBlur={() => setDraft(value)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        }
      }}
    />
  );
}
