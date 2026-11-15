export type PomodoroMode = "focus" | "short" | "long" | "custom";

export const pomodoroModes: PomodoroMode[] = [
  "focus",
  "short",
  "long",
  "custom",
];

export const pomodoroModeLabels: Record<PomodoroMode, string> = {
  focus: "专注",
  short: "小憩",
  long: "长休",
  custom: "自定义",
};

export type PomodoroDurations = Record<PomodoroMode, number>;

export const defaultPomodoroDurations: PomodoroDurations = {
  focus: 25,
  short: 5,
  long: 15,
  custom: 45,
};

export type PomodoroPhase =
  | { kind: "idle" }
  | { kind: "running"; mode: PomodoroMode; endsAt: number }
  | { kind: "paused"; mode: PomodoroMode; remainingMs: number };

export type PomodoroState = {
  mode: PomodoroMode;
  durations: PomodoroDurations;
  phase: PomodoroPhase;
  completedDate: string;
  completedCount: number;
  enabled: boolean;
  task: { id: string; title: string } | null;
};

export type PomodoroTick = {
  state: PomodoroState;
  finished: PomodoroMode | null;
};

const minute = 60_000;

export function pomodoroDay(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

export function clampPomodoroMinutes(value: number): number {
  if (!Number.isFinite(value)) return defaultPomodoroDurations.focus;
  return Math.min(180, Math.max(1, Math.round(value)));
}

export function createPomodoroState(now: number): PomodoroState {
  return {
    mode: "focus",
    durations: { ...defaultPomodoroDurations },
    phase: { kind: "idle" },
    completedDate: pomodoroDay(now),
    completedCount: 0,
    enabled: true,
    task: null,
  };
}

function isMode(value: unknown): value is PomodoroMode {
  return pomodoroModes.includes(value as PomodoroMode);
}

export function pomodoroDurationMs(
  state: PomodoroState,
  mode = state.mode,
): number {
  return clampPomodoroMinutes(state.durations[mode]) * minute;
}

export function withPomodoroDay(
  state: PomodoroState,
  now: number,
): PomodoroState {
  const day = pomodoroDay(now);
  if (state.completedDate === day) return state;
  return { ...state, completedDate: day, completedCount: 0 };
}

export function pomodoroRemainingMs(state: PomodoroState, now: number): number {
  if (state.phase.kind === "running")
    return Math.max(0, state.phase.endsAt - now);
  if (state.phase.kind === "paused") return state.phase.remainingMs;
  return pomodoroDurationMs(state);
}

export function formatPomodoroClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function selectPomodoroMode(
  state: PomodoroState,
  mode: PomodoroMode,
): PomodoroState {
  if (state.phase.kind !== "idle") return state;
  return { ...state, mode };
}

export function setPomodoroDuration(
  state: PomodoroState,
  mode: PomodoroMode,
  minutes: number,
): PomodoroState {
  return {
    ...state,
    durations: {
      ...state.durations,
      [mode]: clampPomodoroMinutes(minutes),
    },
  };
}

export function startPomodoro(state: PomodoroState, now: number): PomodoroState {
  const current = withPomodoroDay(state, now);
  if (current.phase.kind === "running") return current;
  if (current.phase.kind === "paused") {
    return {
      ...current,
      mode: current.phase.mode,
      phase: {
        kind: "running",
        mode: current.phase.mode,
        endsAt: now + current.phase.remainingMs,
      },
    };
  }
  return {
    ...current,
    phase: {
      kind: "running",
      mode: current.mode,
      endsAt: now + pomodoroDurationMs(current),
    },
  };
}

export function pausePomodoro(state: PomodoroState, now: number): PomodoroState {
  if (state.phase.kind !== "running") return state;
  return {
    ...state,
    phase: {
      kind: "paused",
      mode: state.phase.mode,
      remainingMs: Math.max(0, state.phase.endsAt - now),
    },
  };
}

export function assignPomodoroTask(
  state: PomodoroState,
  task: { id: string; title: string },
  now: number,
): PomodoroState {
  const current = withPomodoroDay(
    { ...stopPomodoro(state), task, mode: "focus" },
    now,
  );
  return startPomodoro(current, now);
}

export function stopPomodoro(state: PomodoroState): PomodoroState {
  if (state.phase.kind === "idle") return state;
  return { ...state, mode: state.phase.mode, phase: { kind: "idle" } };
}

export function tickPomodoro(state: PomodoroState, now: number): PomodoroTick {
  const current = withPomodoroDay(state, now);
  if (current.phase.kind !== "running" || current.phase.endsAt > now) {
    return { state: current, finished: null };
  }
  const mode = current.phase.mode;
  return {
    finished: mode,
    state: {
      ...current,
      mode: mode === "focus" ? "short" : "focus",
      phase: { kind: "idle" },
      completedCount:
        mode === "focus" ? current.completedCount + 1 : current.completedCount,
    },
  };
}

export function restorePomodoroState(
  raw: unknown,
  now: number,
): PomodoroTick {
  const base = createPomodoroState(now);
  if (!raw || typeof raw !== "object") return { state: base, finished: null };
  const value = raw as Record<string, unknown>;
  const durations = { ...base.durations };
  if (value.durations && typeof value.durations === "object") {
    const source = value.durations as Record<string, unknown>;
    for (const mode of pomodoroModes) {
      if (typeof source[mode] === "number")
        durations[mode] = clampPomodoroMinutes(source[mode]);
    }
  }
  let state: PomodoroState = {
    ...base,
    mode: isMode(value.mode) ? value.mode : base.mode,
    durations,
    completedDate:
      typeof value.completedDate === "string"
        ? value.completedDate
        : base.completedDate,
    completedCount:
      typeof value.completedCount === "number" && value.completedCount > 0
        ? Math.floor(value.completedCount)
        : 0,
    enabled: value.enabled !== false,
    task:
      value.task &&
      typeof value.task === "object" &&
      typeof (value.task as { id?: unknown }).id === "string" &&
      typeof (value.task as { title?: unknown }).title === "string"
        ? {
            id: (value.task as { id: string }).id,
            title: (value.task as { title: string }).title,
          }
        : null,
  };
  if (value.phase && typeof value.phase === "object") {
    const phase = value.phase as Record<string, unknown>;
    if (
      phase.kind === "running" &&
      isMode(phase.mode) &&
      typeof phase.endsAt === "number"
    ) {
      state = {
        ...state,
        mode: phase.mode,
        phase: { kind: "running", mode: phase.mode, endsAt: phase.endsAt },
      };
    } else if (
      phase.kind === "paused" &&
      isMode(phase.mode) &&
      typeof phase.remainingMs === "number"
    ) {
      state = {
        ...state,
        mode: phase.mode,
        phase: {
          kind: "paused",
          mode: phase.mode,
          remainingMs: Math.max(0, phase.remainingMs),
        },
      };
    }
  }
  return tickPomodoro(state, now);
}

export const pomodoroStorageKey = "praxis.pomodoro.v1";
export const pomodoroChanged = "praxis-pomodoro";

export function readPomodoroState(now = Date.now()): PomodoroState {
  try {
    return restorePomodoroState(
      JSON.parse(localStorage.getItem(pomodoroStorageKey) || "null"),
      now,
    ).state;
  } catch {
    return createPomodoroState(now);
  }
}

export function writePomodoroState(state: PomodoroState) {
  try {
    localStorage.setItem(pomodoroStorageKey, JSON.stringify(state));
  } catch {
    /* 隐私模式写不进本地记录时，设置仍留在当前页面。 */
  }
  window.dispatchEvent(new CustomEvent(pomodoroChanged, { detail: state }));
}
