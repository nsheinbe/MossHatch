/** WebAudio synthesis. Off by default; the context is created on the first user toggle. No audio files. */
import type { Species } from "@mosshatch/core";

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let bed: { stop: () => void } | null = null;
let enabled = false;

function ac(): AudioContext | null {
  if (!enabled) return null;
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function tone(freq: number, dur: number, type: OscillatorType, gain: number, when = 0, slideTo?: number) {
  const c = ac(); if (!c || !master) return;
  const t = c.currentTime + when;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.05);
}

function noise(dur: number, gain: number, lp: number, when = 0) {
  const c = ac(); if (!c || !master) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const s = c.createBufferSource(); s.buffer = buf;
  const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = lp;
  const g = c.createGain(); g.gain.value = gain;
  s.connect(f).connect(g).connect(master); s.start(c.currentTime + when);
}

export const sound = {
  setEnabled(on: boolean) {
    enabled = on;
    if (on) { ac(); this.startBed(); } else { bed?.stop(); bed = null; if (ctx) void ctx.suspend(); }
  },
  /** Soft water drop per keystroke. */
  drop() { const f = 520 + Math.random() * 260; tone(f, 0.16, "sine", 0.09, 0, f * 0.55); },
  /** Egg surfacing tones, one per egg, climbing a pentatonic scale. */
  surface(i: number) { const s = [392, 440, 523.25, 587.33, 659.25, 783.99]; tone(s[i % s.length]!, 0.5, "sine", 0.08); tone(s[i % s.length]! * 2, 0.3, "sine", 0.03, 0.05); },
  crack(i: number) { noise(0.07, 0.25, 4200 - i * 500); tone(180 + i * 60, 0.05, "square", 0.05); },
  hatch() {
    noise(0.5, 0.2, 7000); [523.25, 659.25, 783.99, 1046.5, 1318.5].forEach((f, i) => tone(f, 0.9, "sine", 0.07, i * 0.06));
  },
  /** Warm two-bell chime, used at purchase. */
  chime() { tone(523.25, 1.2, "sine", 0.1); tone(783.99, 1.4, "sine", 0.09, 0.16); },
  lock() { tone(220, 0.06, "square", 0.05); tone(160, 0.08, "square", 0.05, 0.05); },
  unlock() { tone(160, 0.06, "square", 0.05); tone(220, 0.08, "square", 0.05, 0.05); },
  /** A short voice per species, pitched by the spec. */
  voice(species: Species, pitch: number) {
    switch (species) {
      case "fox": tone(620 * pitch, 0.16, "triangle", 0.1, 0, 980 * pitch); tone(900 * pitch, 0.12, "triangle", 0.08, 0.16, 500 * pitch); break;
      case "moth": [1046, 1318, 1568].forEach((f, i) => tone(f * pitch * 0.8, 0.45, "sine", 0.06, i * 0.09)); break;
      case "beetle": for (let i = 0; i < 4; i++) { tone(1400 * pitch, 0.025, "square", 0.05, i * 0.07); } break;
      case "koi": tone(240 * pitch, 0.22, "sine", 0.12, 0, 90 * pitch); noise(0.12, 0.06, 900, 0.03); break;
      case "hare": tone(1100 * pitch, 0.06, "triangle", 0.07, 0, 1500 * pitch); tone(1200 * pitch, 0.06, "triangle", 0.06, 0.09, 1600 * pitch); break;
      case "hedgehog": for (let i = 0; i < 3; i++) noise(0.05, 0.06, 1800 + i * 300, i * 0.08); break;
      case "owl": tone(420 * pitch, 0.3, "sine", 0.1, 0, 380 * pitch); tone(400 * pitch, 0.4, "sine", 0.09, 0.36, 340 * pitch); break;
      case "salamander": tone(1800 * pitch, 0.04, "sine", 0.05, 0, 2400 * pitch); tone(1600 * pitch, 0.05, "sine", 0.05, 0.1, 2200 * pitch); break;
      case "spiritfox": tone(620 * pitch, 0.2, "triangle", 0.09, 0, 980 * pitch); [1318, 1568, 2093].forEach((f, i) => tone(f * pitch, 0.6, "sine", 0.04, 0.15 + i * 0.08)); break;
    }
  },
  startBed() {
    const c = ac(); if (!c || !master || bed) return;
    const len = c.sampleRate * 3;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) { last = (last + (Math.random() * 2 - 1) * 0.02) * 0.995; d[i] = last * 6; }
    const s = c.createBufferSource(); s.buffer = buf; s.loop = true;
    const f = c.createBiquadFilter(); f.type = "lowpass"; f.frequency.value = 420;
    const g = c.createGain(); g.gain.value = 0.05;
    s.connect(f).connect(g).connect(master); s.start();
    // Crickets: a very quiet chirp now and then.
    const iv = window.setInterval(() => { if (enabled) for (let i = 0; i < 3; i++) tone(4200, 0.03, "sine", 0.008, i * 0.06); }, 3800);
    bed = { stop: () => { try { s.stop(); } catch { /* already stopped */ } clearInterval(iv); } };
  },
};
