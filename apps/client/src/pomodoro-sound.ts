export type PomodoroAmbience =
  | "rain"
  | "thunder"
  | "fire"
  | "waves"
  | "birds"
  | "stream"
  | "forest"
  | "cafe"
  | "cat";

export const pomodoroAmbienceLabels: Record<PomodoroAmbience, string> = {
  rain: "雨声",
  thunder: "雷声",
  fire: "篝火",
  waves: "海浪",
  birds: "鸟鸣",
  stream: "溪流",
  forest: "森林",
  cafe: "咖啡厅",
  cat: "猫",
};

const sources: Record<PomodoroAmbience, string> = {
  rain: "ambience/rain.mp3?v=2",
  thunder: "ambience/thunder.mp3?v=2",
  fire: "ambience/fire.mp3",
  waves: "ambience/waves.mp3?v=2",
  birds: "ambience/birds.mp3",
  stream: "ambience/stream.mp3",
  forest: "ambience/forest.mp3",
  cafe: "ambience/cafe.mp3",
  cat: "ambience/cat.mp3",
};

let generation = 0;
let current: { stop: () => void } | null = null;
let audio: AudioContext | null = null;

function context(): AudioContext {
  if (!audio || audio.state === "closed") audio = new AudioContext();
  return audio;
}

function halt() {
  current?.stop();
  current = null;
}

export function warmPomodoroAudio() {
  const next = context();
  if (next.state === "suspended") void next.resume();
}

export function stopPomodoroAmbience() {
  generation += 1;
  halt();
}

function fileUrl(kind: PomodoroAmbience) {
  const base = import.meta.env.BASE_URL || "/";
  return `${base}${sources[kind]}`;
}

export async function playPomodoroAmbience(kind: PomodoroAmbience) {
  const ticket = ++generation;
  halt();
  const url = fileUrl(kind);
  const pair = [new Audio(url), new Audio(url)];
  for (const item of pair) {
    item.preload = "auto";
    item.volume = 0;
  }
  const level = 0.8;
  const seam = 0.45;
  let index = 0;
  let bridging = false;
  let stopped = false;
  let frame = 0;
  const opened = performance.now();
  const watch = () => {
    if (stopped) return;
    const envelope = Math.min(1, (performance.now() - opened) / 350);
    const active = pair[index];
    const idle = pair[1 - index];
    if (!active || !idle) return;
    const left = active.duration - active.currentTime;
    if (!bridging && Number.isFinite(left) && left <= seam && active.duration > seam * 3) {
      bridging = true;
      idle.currentTime = 0;
      void idle.play();
    }
    if (bridging) {
      const remain = Math.max(0, active.duration - active.currentTime);
      const mix = 1 - Math.min(1, remain / seam);
      active.volume = level * envelope * (1 - mix);
      idle.volume = level * envelope * mix;
      if (remain <= 0.03 || active.ended) {
        active.pause();
        index = 1 - index;
        bridging = false;
      }
    } else {
      active.volume = level * envelope;
    }
    frame = requestAnimationFrame(watch);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    const from = pair.map((item) => item.volume);
    const start = performance.now();
    const down = (now: number) => {
      const mix = Math.min(1, (now - start) / 180);
      pair.forEach((item, itemIndex) => {
        item.volume = (from[itemIndex] ?? 0) * (1 - mix);
      });
      if (mix < 1) {
        requestAnimationFrame(down);
        return;
      }
      for (const item of pair) {
        item.pause();
        item.removeAttribute("src");
        item.load();
      }
    };
    requestAnimationFrame(down);
  };
  current = { stop };
  frame = requestAnimationFrame(watch);
  try {
    await Promise.all(pair.map((item) => item.play()));
  } catch {
    if (ticket === generation) halt();
    return;
  }
  const idle = pair[1];
  if (idle && !stopped && ticket === generation) {
    idle.pause();
    idle.currentTime = 0;
  }
  if (ticket !== generation) stop();
}

export async function playPomodoroChime() {
  const target = context();
  if (target.state === "suspended") await target.resume();
  const start = target.currentTime;
  for (const [offset, frequency] of [
    [0, 523.25],
    [0.16, 659.25],
    [0.32, 783.99],
  ] as const) {
    const oscillator = target.createOscillator();
    const gain = target.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = frequency;
    gain.gain.setValueAtTime(0.0001, start + offset);
    gain.gain.exponentialRampToValueAtTime(0.045, start + offset + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + offset + 0.42);
    oscillator.connect(gain);
    gain.connect(target.destination);
    oscillator.start(start + offset);
    oscillator.stop(start + offset + 0.46);
  }
}
