export type PomodoroAmbience = "rain" | "fire" | "waves" | "white";

export const pomodoroAmbienceLabels: Record<PomodoroAmbience, string> = {
  rain: "雨声",
  fire: "篝火",
  waves: "海浪",
  white: "白噪音",
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

function noiseBuffer(
  target: AudioContext,
  seconds: number,
  color: "white" | "brown",
) {
  const length = Math.floor(target.sampleRate * seconds);
  const buffer = target.createBuffer(1, length, target.sampleRate);
  const data = buffer.getChannelData(0);
  let brown = 0;
  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    brown = (brown + 0.02 * white) / 1.02;
    data[index] = color === "white" ? white * 0.35 : brown * 3.2;
  }
  return buffer;
}

export function stopPomodoroAmbience() {
  generation += 1;
  halt();
}

export async function playPomodoroAmbience(kind: PomodoroAmbience) {
  const ticket = ++generation;
  halt();
  const target = context();
  if (target.state === "suspended") await target.resume();
  if (ticket !== generation) return;
  const master = target.createGain();
  master.gain.value = kind === "white" ? 0.07 : 0.2;
  master.connect(target.destination);
  const source = target.createBufferSource();
  source.buffer = noiseBuffer(
    target,
    2,
    kind === "white" ? "white" : "brown",
  );
  source.loop = true;
  const filter = target.createBiquadFilter();
  if (kind === "rain") {
    filter.type = "highpass";
    filter.frequency.value = 900;
  } else if (kind === "fire") {
    filter.type = "lowpass";
    filter.frequency.value = 480;
  } else if (kind === "waves") {
    filter.type = "lowpass";
    filter.frequency.value = 300;
  } else {
    filter.type = "highpass";
    filter.frequency.value = 160;
  }
  source.connect(filter);
  filter.connect(master);
  const extras: Array<{ stop: () => void }> = [];
  if (kind === "waves") {
    const lfo = target.createOscillator();
    const depth = target.createGain();
    lfo.frequency.value = 0.07;
    depth.gain.value = 0.09;
    lfo.connect(depth);
    depth.connect(master.gain);
    lfo.start();
    extras.push({
      stop() {
        lfo.stop();
      },
    });
  }
  if (kind === "fire" || kind === "rain") {
    const timer = window.setInterval(() => {
      const burst = target.createBufferSource();
      burst.buffer = noiseBuffer(target, 0.08, "white");
      const gain = target.createGain();
      gain.gain.setValueAtTime(
        kind === "fire" ? 0.28 : 0.1,
        target.currentTime,
      );
      gain.gain.exponentialRampToValueAtTime(0.001, target.currentTime + 0.08);
      const band = target.createBiquadFilter();
      band.type = "bandpass";
      band.frequency.value = kind === "fire" ? 1600 : 4200;
      burst.connect(band);
      band.connect(gain);
      gain.connect(master);
      burst.start();
      burst.stop(target.currentTime + 0.09);
    }, kind === "fire" ? 320 : 110);
    extras.push({
      stop() {
        window.clearInterval(timer);
      },
    });
  }
  source.start();
  if (ticket !== generation) {
    source.stop();
    for (const extra of extras) extra.stop();
    master.disconnect();
    return;
  }
  current = {
    stop() {
      try {
        source.stop();
      } catch {
        /* already stopped */
      }
      for (const extra of extras) extra.stop();
      master.disconnect();
    },
  };
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
