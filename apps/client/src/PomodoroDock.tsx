import { useEffect, useRef, useState } from "react";
import {
  formatPomodoroClock,
  pausePomodoro,
  pomodoroModeLabels,
  pomodoroModes,
  pomodoroRemainingMs,
  restorePomodoroState,
  selectPomodoroMode,
  setPomodoroDuration,
  startPomodoro,
  pomodoroChanged,
  stopPomodoro,
  tickPomodoro,
  type PomodoroMode,
  type PomodoroState,
} from "./pomodoro";
import {
  playPomodoroAmbience,
  playPomodoroChime,
  pomodoroAmbienceLabels,
  stopPomodoroAmbience,
  warmPomodoroAudio,
  type PomodoroAmbience,
} from "./pomodoro-sound";

const storageKey = "praxis.pomodoro.v1";
const ambiences = Object.keys(pomodoroAmbienceLabels) as PomodoroAmbience[];

function readStored(now: number) {
  try {
    return restorePomodoroState(
      JSON.parse(localStorage.getItem(storageKey) || "null"),
      now,
    );
  } catch {
    return restorePomodoroState(null, now);
  }
}

function statusLabel(state: PomodoroState, finished: PomodoroMode | null) {
  if (state.phase.kind === "running") {
    if (state.phase.mode === "focus") return "专注中";
    if (state.phase.mode === "short") return "小憩中";
    if (state.phase.mode === "long") return "长休中";
    return "计时中";
  }
  if (state.phase.kind === "paused") return "已暂停";
  if (finished === "focus") return "专注完成";
  if (finished) return "本轮结束";
  return "待开始";
}

function barLabel(state: PomodoroState) {
  if (state.phase.kind === "running") return "暂停";
  if (state.phase.kind === "paused") return "继续";
  if (state.mode === "focus") return "番茄专注";
  if (state.mode === "short") return "开始小憩";
  if (state.mode === "long") return "开始长休";
  return "开始计时";
}

export function PomodoroDock({
  variant = "dock",
}: {
  variant?: "dock" | "page";
} = {}) {
  const dock = useRef<HTMLDivElement>(null);
  const stateRef = useRef<PomodoroState | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [state, setState] = useState<PomodoroState>(
    () => readStored(Date.now()).state,
  );
  const [finished, setFinished] = useState<PomodoroMode | null>(
    () => readStored(Date.now()).finished,
  );
  const [expanded, setExpanded] = useState(false);
  const [soundsOpen, setSoundsOpen] = useState(false);
  const [sound, setSound] = useState<PomodoroAmbience | null>(null);
  const [announce, setAnnounce] = useState("");
  stateRef.current = state;

  function commit(next: PomodoroState) {
    stateRef.current = next;
    setState(next);
  }

  useEffect(() => {
    const baseTitle = document.title.replace(/^\d+:\d{2} · [^·]+ · /, "");
    const id = window.setInterval(() => {
      const nextNow = Date.now();
      setNow(nextNow);
      const current = stateRef.current;
      if (!current) return;
      const result = tickPomodoro(current, nextNow);
      if (stateRef.current !== current) return;
      if (result.finished) {
        stateRef.current = result.state;
        setState(result.state);
        setFinished(result.finished);
        setAnnounce(
          result.finished === "focus"
            ? `专注完成，今天已完成 ${result.state.completedCount} 个番茄`
            : "本轮结束",
        );
        void playPomodoroChime().catch(() => {});
      } else if (result.state !== current) {
        stateRef.current = result.state;
        setState(result.state);
      }
      const shown = result.finished || result.state !== current ? result.state : current;
      document.title =
        shown.phase.kind === "running"
          ? `${formatPomodoroClock(pomodoroRemainingMs(shown, nextNow))} · ${pomodoroModeLabels[shown.phase.mode]} · Praxis`
          : baseTitle;
    }, 250);
    return () => {
      window.clearInterval(id);
      document.title = baseTitle;
      stopPomodoroAmbience();
    };
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      /* 隐私模式写不进本地记录时，这一轮仍可继续计时。 */
    }
  }, [state]);
  useEffect(() => {
    const sync = (event: Event) => {
      const detail = (event as CustomEvent<PomodoroState>).detail;
      if (!detail) return;
      if (!detail.enabled) stopPomodoroAmbience();
      setState(detail);
    };
    window.addEventListener(pomodoroChanged, sync);
    return () => window.removeEventListener(pomodoroChanged, sync);
  }, []);

  useEffect(() => {
    if (!expanded && !soundsOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!dock.current?.contains(event.target as Node)) {
        setExpanded(false);
        setSoundsOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setExpanded(false);
      setSoundsOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [expanded, soundsOpen]);

  const remaining = pomodoroRemainingMs(state, now);
  const clock = formatPomodoroClock(remaining);
  const running = state.phase.kind === "running";
  const locked = state.phase.kind !== "idle";
  const activeMode = state.phase.kind === "idle" ? state.mode : state.phase.mode;

  function begin() {
    const nextNow = Date.now();
    warmPomodoroAudio();
    setNow(nextNow);
    setFinished(null);
    setAnnounce("");
    if (running) commit(pausePomodoro(state, nextNow));
    else commit(startPomodoro(state, nextNow));
  }

  function chooseSound(next: PomodoroAmbience | null) {
    warmPomodoroAudio();
    setSoundsOpen(false);
    if (!next || next === sound) {
      setSound(null);
      stopPomodoroAmbience();
      return;
    }
    setSound(next);
    void playPomodoroAmbience(next);
  }

  if (variant !== "page" && !state.enabled) return null;

  if (variant === "page") {
    return (
      <div
        className="pomodoro-page"
        ref={dock}
        onPointerDown={() => warmPomodoroAudio()}
      >
        <p className="sr-only" role="status">
          {statusLabel(state, finished)}，今日完成 {state.completedCount} 个番茄。{announce}
        </p>
        <section className="pomodoro-page-card" aria-label="番茄钟">
          <p className="pomodoro-clock" role="timer">
            {clock}
          </p>
          <p className="pomodoro-page-status">{statusLabel(state, finished)}</p>
          {state.task && (
            <p className="pomodoro-task" title={state.task.title}>
              {state.task.title}
            </p>
          )}
          <p className="pomodoro-page-count">今天已完成 {state.completedCount} 个番茄</p>
          <div className="pomodoro-modes" role="group" aria-label="番茄钟模式">
            {pomodoroModes.map((mode) => (
              <button
                key={mode}
                type="button"
                className={mode === activeMode ? "is-selected" : undefined}
                aria-pressed={mode === activeMode}
                disabled={locked}
                onClick={() => {
                  setFinished(null);
                  commit(selectPomodoroMode(state, mode));
                }}
              >
                {pomodoroModeLabels[mode]}
              </button>
            ))}
          </div>
          {!locked && (
            <div className="pomodoro-settings">
              {pomodoroModes.map((mode) => (
                <div key={mode}>
                  <span>{pomodoroModeLabels[mode]}</span>
                  <button
                    type="button"
                    aria-label={`${pomodoroModeLabels[mode]}减少五分钟`}
                    onClick={() =>
                      commit(
                        setPomodoroDuration(
                          state,
                          mode,
                          state.durations[mode] - 5,
                        ),
                      )
                    }
                  >
                    −
                  </button>
                  <b>{state.durations[mode]} 分钟</b>
                  <button
                    type="button"
                    aria-label={`${pomodoroModeLabels[mode]}增加五分钟`}
                    onClick={() =>
                      commit(
                        setPomodoroDuration(
                          state,
                          mode,
                          state.durations[mode] + 5,
                        ),
                      )
                    }
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="pomodoro-page-controls">
            {locked && (
              <button
                type="button"
                className="pomodoro-end"
                onClick={() => {
                  setFinished(null);
                  commit(stopPomodoro(state));
                }}
              >
                结束
              </button>
            )}
            <button type="button" className="pomodoro-go" onClick={begin}>
              {running ? <PauseIcon /> : <PlayIcon />}
              {barLabel(state)}
            </button>
          </div>
          <div className="pomodoro-noise-wrap">
            {soundsOpen && (
              <div className="pomodoro-sounds" role="menu" aria-label="白噪音">
                {ambiences.map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sound === item}
                    onClick={() => chooseSound(item)}
                  >
                    {pomodoroAmbienceLabels[item]}
                  </button>
                ))}
                <button type="button" role="menuitem" onClick={() => chooseSound(null)}>
                  关闭
                </button>
              </div>
            )}
            <button
              type="button"
              className="pomodoro-noise"
              aria-pressed={sound !== null}
              aria-expanded={soundsOpen}
              onClick={() => setSoundsOpen((open) => !open)}
            >
              <SpeakerIcon />
              {sound ? pomodoroAmbienceLabels[sound] : "白噪音"}
            </button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div
      className="pomodoro-dock"
      ref={dock}
      onPointerDown={() => warmPomodoroAudio()}
    >
      <p className="sr-only" role="status">
        {statusLabel(state, finished)}，今日完成 {state.completedCount} 个番茄。{announce}
      </p>
      {expanded && (
        <div className="pomodoro-mode-panel">
          <div className="pomodoro-modes" role="group" aria-label="番茄钟模式">
            {pomodoroModes.map((mode) => (
              <button
                key={mode}
                type="button"
                className={mode === activeMode ? "is-selected" : undefined}
                aria-pressed={mode === activeMode}
                disabled={locked}
                onClick={() => {
                  setFinished(null);
                  commit(selectPomodoroMode(state, mode));
                }}
              >
                {pomodoroModeLabels[mode]}
              </button>
            ))}
          </div>
          {!locked && (
            <div className="pomodoro-settings">
              {pomodoroModes.map((mode) => (
                <div key={mode}>
                  <span>{pomodoroModeLabels[mode]}</span>
                  <button
                    type="button"
                    aria-label={`${pomodoroModeLabels[mode]}减少五分钟`}
                    onClick={() =>
                      commit(
                        setPomodoroDuration(
                          state,
                          mode,
                          state.durations[mode] - 5,
                        ),
                      )
                    }
                  >
                    −
                  </button>
                  <b>{state.durations[mode]} 分钟</b>
                  <button
                    type="button"
                    aria-label={`${pomodoroModeLabels[mode]}增加五分钟`}
                    onClick={() =>
                      commit(
                        setPomodoroDuration(
                          state,
                          mode,
                          state.durations[mode] + 5,
                        ),
                      )
                    }
                  >
                    +
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      <section className="pomodoro-bar" aria-label="番茄钟">
        <button
          type="button"
          className="pomodoro-gear"
          aria-label="番茄钟设置"
          aria-expanded={expanded}
          onClick={() => {
            setExpanded((open) => !open);
            setSoundsOpen(false);
          }}
        >
          <GearIcon />
        </button>
        <div className="pomodoro-center">
          <p className="pomodoro-clock" role="timer">
            {clock}
          </p>
          {state.task && (
            <p className="pomodoro-task" title={state.task.title}>
              {state.task.title}
            </p>
          )}
          <div className="pomodoro-noise-wrap">
            {soundsOpen && (
              <div className="pomodoro-sounds" role="menu" aria-label="白噪音">
                {ambiences.map((item) => (
                  <button
                    key={item}
                    type="button"
                    role="menuitemradio"
                    aria-checked={sound === item}
                    onClick={() => chooseSound(item)}
                  >
                    {pomodoroAmbienceLabels[item]}
                  </button>
                ))}
                <button type="button" role="menuitem" onClick={() => chooseSound(null)}>
                  关闭
                </button>
              </div>
            )}
            <button
              type="button"
              className="pomodoro-noise"
              aria-pressed={sound !== null}
              aria-expanded={soundsOpen}
              onClick={() => {
                setSoundsOpen((open) => !open);
                setExpanded(false);
              }}
            >
              <SpeakerIcon />
              {sound ? pomodoroAmbienceLabels[sound] : "白噪音"}
            </button>
          </div>
        </div>
        <div className="pomodoro-actions">
          {locked && (
            <button
              type="button"
              className="pomodoro-end"
              onClick={() => {
                setFinished(null);
                commit(stopPomodoro(state));
              }}
            >
              结束
            </button>
          )}
          <button type="button" className="pomodoro-go" onClick={begin}>
            {running ? <PauseIcon /> : <PlayIcon />}
            {barLabel(state)}
          </button>
        </div>
      </section>
    </div>
  );
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" />
    </svg>
  );
}

function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h3.5v14H7zm6.5 0H17v14h-3.5z" />
    </svg>
  );
}

function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9c.3.6.9 1 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  );
}

function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 10h3l4-3v10l-4-3H4zM16 9a4 4 0 0 1 0 6" />
    </svg>
  );
}
