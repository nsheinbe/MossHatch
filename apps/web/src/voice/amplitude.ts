import type { AmplitudeSource } from "./types";

/**
 * Glow from streamed text: each word that arrives adds energy (longer words, a little more; punctuation, a breath), which decays
 * quickly, so the creature's light flickers with its speech the way a voice would. Pure and time-driven, so it is tested without a DOM.
 */
export class TokenAmplitude implements AmplitudeSource {
  private energy = 0;
  private at = 0;
  constructor(private readonly halfLifeMs = 140) {}

  /** A streamed piece of the reply arrived at `nowMs`. */
  push(text: string, nowMs: number) {
    this.decay(nowMs);
    const letters = (text.match(/[\p{L}\p{N}]/gu) ?? []).length;
    const pause = /[.,!?;:]\s*$/.test(text) ? 0.15 : 0;
    this.energy = Math.min(1.4, this.energy + Math.min(0.75, 0.25 + letters * 0.05) - pause);
  }

  level(nowMs: number): number {
    this.decay(nowMs);
    return Math.max(0, Math.min(1, this.energy));
  }

  private decay(nowMs: number) {
    if (this.at) this.energy *= Math.pow(0.5, Math.max(0, nowMs - this.at) / this.halfLifeMs);
    this.at = nowMs;
  }
}

/**
 * The audio-driven source voice will use: RMS of an AnalyserNode's time-domain data. A stub until a TTS provider is wired: it is not
 * constructed anywhere, and it never touches the microphone (it reads the creature's own playback, not input).
 */
export class AnalyserAmplitude implements AmplitudeSource {
  private buf: Uint8Array<ArrayBuffer>;
  constructor(private readonly analyser: AnalyserNode) { this.buf = new Uint8Array(analyser.fftSize); }
  level(): number {
    this.analyser.getByteTimeDomainData(this.buf);
    let sum = 0;
    for (const v of this.buf) { const x = (v - 128) / 128; sum += x * x; }
    return Math.min(1, Math.sqrt(sum / this.buf.length) * 3);
  }
}

/** Drive a world hook from an amplitude source every animation frame until stopped. */
export function driveGlow(source: AmplitudeSource, set: (level: number) => void): () => void {
  let raf = 0, live = true;
  const tick = (t: number) => { if (!live) return; set(source.level(t)); raf = requestAnimationFrame(tick); };
  raf = requestAnimationFrame(tick);
  return () => { live = false; cancelAnimationFrame(raf); set(0); };
}
