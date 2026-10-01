export interface Tier {
  dprMax: number; fireflies: number; pollen: number; trees: number; grass: number; antialias: boolean;
}

export function pickTier(): Tier {
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const small = Math.min(window.innerWidth, window.innerHeight) < 700;
  if (coarse || small) return { dprMax: 1.5, fireflies: 32, pollen: 28, trees: 14, grass: 420, antialias: false };
  return { dprMax: 1.75, fireflies: 60, pollen: 60, trees: 24, grass: 900, antialias: true };
}

/** Steps DPR down when the frame average stays above ~22 ms. */
export class Adaptive {
  private samples: number[] = [];
  private cooldown = 0;
  dpr: number;
  constructor(private max: number, private min = 0.75) { this.dpr = Math.min(window.devicePixelRatio || 1, max); }
  /** Returns a new DPR when it should change, otherwise null. */
  frame(ms: number): number | null {
    this.cooldown -= ms;
    this.samples.push(ms);
    if (this.samples.length > 45) this.samples.shift();
    if (this.samples.length < 45 || this.cooldown > 0) return null;
    const avg = this.samples.reduce((a, b) => a + b, 0) / this.samples.length;
    if (avg > 22 && this.dpr > this.min) {
      this.dpr = Math.max(this.min, +(this.dpr - 0.25).toFixed(2));
      this.samples.length = 0;
      this.cooldown = 2000;
      return this.dpr;
    }
    return null;
  }
}
