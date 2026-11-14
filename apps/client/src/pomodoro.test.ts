import { expect, test } from "vitest";
import {
  clampPomodoroMinutes,
  createPomodoroState,
  formatPomodoroClock,
  pausePomodoro,
  pomodoroDay,
  restorePomodoroState,
  selectPomodoroMode,
  setPomodoroDuration,
  startPomodoro,
  stopPomodoro,
  tickPomodoro,
} from "./pomodoro";

const now = Date.parse("2026-11-14T06:00:00Z");

test("formats whole seconds and keeps a fresh 25 minute session at 25:00", () => {
  expect(formatPomodoroClock(0)).toBe("00:00");
  expect(formatPomodoroClock(1_000)).toBe("00:01");
  expect(formatPomodoroClock(1_500_000)).toBe("25:00");
  expect(formatPomodoroClock(1_500_400)).toBe("25:00");
  expect(formatPomodoroClock(61_000)).toBe("01:01");
});

test("keeps custom durations inside one minute and three hours", () => {
  expect(clampPomodoroMinutes(0)).toBe(1);
  expect(clampPomodoroMinutes(25.4)).toBe(25);
  expect(clampPomodoroMinutes(200)).toBe(180);
});

test("counts a finished focus session and offers a short break", () => {
  const started = startPomodoro(createPomodoroState(now), now);
  const done = tickPomodoro(started, now + 25 * 60_000);
  expect(done.finished).toBe("focus");
  expect(done.state.completedCount).toBe(1);
  expect(done.state.mode).toBe("short");
  expect(done.state.phase.kind).toBe("idle");
});

test("does not count a break or an abandoned session", () => {
  const focus = startPomodoro(
    selectPomodoroMode(createPomodoroState(now), "short"),
    now,
  );
  const done = tickPomodoro(focus, now + 5 * 60_000);
  expect(done.finished).toBe("short");
  expect(done.state.completedCount).toBe(0);
  expect(done.state.mode).toBe("focus");
  const abandoned = stopPomodoro(startPomodoro(createPomodoroState(now), now));
  expect(abandoned.phase.kind).toBe("idle");
  expect(abandoned.completedCount).toBe(0);
});

test("pause keeps the remaining time", () => {
  const started = startPomodoro(createPomodoroState(now), now);
  const paused = pausePomodoro(started, now + 60_000);
  expect(paused.phase).toEqual({
    kind: "paused",
    mode: "focus",
    remainingMs: 24 * 60_000,
  });
  const resumed = startPomodoro(paused, now + 120_000);
  expect(resumed.phase).toEqual({
    kind: "running",
    mode: "focus",
    endsAt: now + 120_000 + 24 * 60_000,
  });
});

test("ignores mode changes while a session is running", () => {
  const started = startPomodoro(createPomodoroState(now), now);
  expect(selectPomodoroMode(started, "long")).toBe(started);
});

test("resets today's count after midnight and restores a finished session once", () => {
  const started = startPomodoro(createPomodoroState(now), now);
  const stored = {
    ...started,
    completedCount: 2,
    phase: { kind: "running", mode: "focus", endsAt: now + 1_000 },
  };
  const nextDay = now + 36 * 60 * 60 * 1000;
  const restored = restorePomodoroState(stored, nextDay);
  expect(restored.finished).toBe("focus");
  expect(restored.state.completedCount).toBe(1);
  expect(restored.state.completedDate).toBe(pomodoroDay(nextDay));
  expect(setPomodoroDuration(restored.state, "focus", 50).durations.focus).toBe(
    50,
  );
});
