import type { Emerge, Idle, Particle, Reaction } from "@mosshatch/core";

/**
 * The motion library. A CreatureSpec names moves from these fixed tables; it never carries code. Each move adds to a Pose that the
 * creature turns into shader uniforms, so every move costs a few multiplies per frame and no draw calls.
 */
export interface Pose {
  tail: number; yaw: number; ear: number; wing: number; leg: number;
  /** Multiplies eye openness (1 = open). */
  eyes: number;
  pitch: number; squash: number; tilt: number; lift: number; curl: number; spin: number; wave: number;
}
export const zeroPose = (p: Pose) => { p.tail = p.yaw = p.ear = p.wing = p.leg = p.pitch = p.squash = p.tilt = p.lift = p.curl = p.spin = p.wave = 0; p.eyes = 1; return p; };
export const newPose = (): Pose => zeroPose({} as Pose);

export interface Move {
  dur: number;
  /** k is progress 0..1, t is world time in seconds. */
  run(p: Pose, k: number, t: number): void;
  /** Particles to emit once when the move starts. */
  burst?: Particle;
}

/** Smooth rise and fall over a move. */
const env = (k: number) => Math.sin(Math.PI * Math.min(1, Math.max(0, k)));
const hold = (k: number) => Math.min(1, k * 5, (1 - k) * 5);
const easeInOut = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

export const IDLE_MOVES: Record<Idle, Move> = {
  preen: { dur: 1.8, run: (p, k, t) => { const e = hold(k); p.pitch += 0.45 * e; p.yaw += Math.sin(t * 7) * 0.25 * e; p.ear += Math.sin(t * 9) * 0.15 * e; } },
  sniff: { dur: 1.4, run: (p, k, t) => { const e = hold(k); p.pitch += (0.18 + Math.sin(t * 22) * 0.08) * e; p.ear += 0.1 * e; } },
  hover: { dur: 2.4, run: (p, k, t) => { const e = env(k); p.lift += 0.16 * e; p.wing += Math.sin(t * 16) * 0.4 * e; p.tail += Math.sin(t * 3) * 0.3 * e; } },
  hop: { dur: 0.9, run: (p, k) => { const a = Math.min(1, k / 0.2); if (k < 0.2) p.squash -= 0.1 * Math.sin(a * Math.PI); else p.lift += Math.sin(((k - 0.2) / 0.8) * Math.PI) * 0.28; } },
  "curl-sleep": { dur: 3.2, run: (p, k) => { const e = hold(k); p.curl = Math.max(p.curl, e); p.eyes *= 1 - 0.9 * e; } },
  "tail-flick": { dur: 1.1, run: (p, k, t) => { p.tail += Math.sin(t * 16) * 0.7 * env(k); } },
  "look-around": { dur: 2.6, run: (p, k) => { p.yaw += Math.sin(k * Math.PI * 2) * 1.05 * hold(k); p.pitch -= 0.08 * env(k); } },
  flutter: { dur: 1.2, run: (p, k, t) => { const e = env(k); p.wing += Math.sin(t * 30) * 0.8 * e; p.lift += 0.06 * e; } },
  thump: { dur: 1.2, run: (p, k) => { p.squash -= 0.07 * Math.abs(Math.sin(k * Math.PI * 3)); p.ear += 0.25 * env(k); } },
  bask: { dur: 3.4, run: (p, k, t) => { const e = hold(k); p.curl = Math.max(p.curl, 0.35 * e); p.eyes *= 1 - 0.55 * e; p.tail += Math.sin(t * 1.6) * 0.25 * e; } },
  surface: { dur: 2.2, run: (p, k) => { const e = env(k); p.lift += 0.2 * e; p.tilt -= 0.25 * e; } },
};

export const REACTIONS: Record<Reaction, Move> = {
  hop: { dur: 0.5, run: (p, k) => { p.lift += Math.sin(k * Math.PI) * 0.4; } },
  spin: { dur: 0.8, run: (p, k) => { p.spin += easeInOut(k) * Math.PI * 2; p.lift += 0.1 * env(k); } },
  squash: { dur: 0.55, run: (p, k) => { p.squash -= 0.24 * Math.sin(k * Math.PI * 2) * (1 - k); } },
  flutter: { dur: 0.9, run: (p, k, t) => { const e = env(k); p.wing += Math.sin(t * 34) * 1.0 * e; p.lift += 0.18 * e; } },
  curl: { dur: 1.5, run: (p, k) => { p.curl = Math.max(p.curl, hold(k)); p.eyes *= 1 - hold(k); } },
  sparkle: { dur: 0.7, run: (p, k) => { p.squash += 0.08 * env(k); p.lift += 0.08 * env(k); }, burst: "motes" },
};

/** Where the newborn is during emergence, k 0..1: scale, height, forward tilt. */
export function emergePose(kind: Emerge, k: number): { scale: number; y: number; tilt: number } {
  switch (kind) {
    case "shoulder-out": { const e = easeInOut(Math.min(1, k * 1.3)); return { scale: 0.6 + 0.4 * e, y: -0.3 + 0.3 * e, tilt: 0.7 * (1 - e) }; }
    case "peek-then-leap": {
      if (k < 0.55) { const e = Math.min(1, k / 0.25); return { scale: 0.85, y: -0.35 + 0.22 * e, tilt: -0.15 * e }; }
      const j = (k - 0.55) / 0.45; return { scale: 1, y: -0.13 + 0.13 * j + Math.sin(j * Math.PI) * 0.55, tilt: 0.2 * Math.sin(j * Math.PI) };
    }
    case "drift-up": { const e = easeInOut(k); return { scale: Math.min(1, k * 2.2), y: Math.sin(e * Math.PI) * 0.55 + 0.02 * e, tilt: 0 }; }
    case "burrow-up": { const e = easeInOut(Math.min(1, k * 1.2)); return { scale: 1, y: -0.8 + 0.8 * e + Math.sin(k * 40) * 0.015 * (1 - e), tilt: 0.25 * (1 - e) }; }
    default: { const s = k < 0.6 ? (k / 0.6) * 1.25 : 1.25 - ((k - 0.6) / 0.4) * 0.25; return { scale: s, y: Math.sin(Math.min(1, k) * Math.PI) * 0.1, tilt: 0 }; }
  }
}

/** Particle looks. kind: 0 soft, 1 shard, 3 petal, 4 bubble (see burst.frag). */
export interface ParticleStyle { kind: number; count: number; speed: number; up: number; size: number; life: number; gravity: number; light: number }
export const PARTICLE_STYLE: Record<Particle, ParticleStyle> = {
  sparks: { kind: 0, count: 30, speed: 1.8, up: 3, size: 14, life: 1.4, gravity: 2.5, light: 0.62 },
  dust: { kind: 0, count: 22, speed: 1.2, up: 0.8, size: 24, life: 1.6, gravity: 0.4, light: 0.72 },
  petals: { kind: 3, count: 24, speed: 1.1, up: 2.2, size: 20, life: 2.6, gravity: 0.9, light: 0.75 },
  bubbles: { kind: 4, count: 22, speed: 0.6, up: 1.4, size: 18, life: 2.2, gravity: -0.4, light: 0.8 },
  motes: { kind: 0, count: 26, speed: 0.7, up: 1.2, size: 12, life: 2.8, gravity: -0.2, light: 0.78 },
};

/** Pick an idle move by weight with a 0..1 draw. */
export function pickIdle(list: { kind: Idle; weight: number }[], r: number): Idle {
  const total = list.reduce((a, b) => a + b.weight, 0);
  let x = r * total;
  for (const it of list) { x -= it.weight; if (x < 0) return it.kind; }
  return list[list.length - 1]!.kind;
}
