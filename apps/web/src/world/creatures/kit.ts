import * as THREE from "three";
import { sanitizeSpec, stream, type CreatureSpec, type Hsl } from "@mosshatch/core";
import { GeoBuilder, xf, type PartOpts } from "../geo";

export { cardTraits, TIER_LABEL } from "@mosshatch/core";
export { IDLE_MOVES, REACTIONS, PARTICLE_STYLE, emergePose, pickIdle, newPose, zeroPose } from "./moves";

/**
 * The creature kit: per-species builders and the motion library. It is its own lazy chunk, loaded next to the engine, so the engine
 * chunk carries none of it. Builders read the CreatureSpec only and merge every part into one geometry (one draw call per creature);
 * parts are animated in hatch.vert by part id.
 */

const sph = new THREE.SphereGeometry(1, 14, 10);
const sphHi = new THREE.SphereGeometry(1, 20, 14);
const cone = new THREE.ConeGeometry(1, 1, 8, 1);
const cyl = new THREE.CylinderGeometry(1, 1, 1, 8);
const box = new THREE.BoxGeometry(1, 1, 1);
const dome = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const torus = new THREE.TorusGeometry(1, 0.32, 6, 16);
const octa = new THREE.OctahedronGeometry(1, 0);
const wingGeo = (shape: "kite" | "round" | "swallow") => {
  const g = new THREE.PlaneGeometry(1, 1, 6, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) + 0.5, v = p.getY(i);
    const w = shape === "round" ? Math.sin(Math.min(1, u) * Math.PI) * 0.85 + 0.15 * (1 - u)
      : shape === "swallow" ? Math.sin(Math.min(1, u * 1.3) * Math.PI * 0.5) * (1 - 0.45 * u) : Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.55) * (1 - 0.18 * u);
    const sweep = shape === "swallow" ? u * 0.5 : u * 0.25;
    p.setXYZ(i, u, v * w * 1.5 - sweep, Math.sin(u * 2) * 0.03);
  }
  g.computeVertexNormals();
  return g;
};
const WINGS = { kite: wingGeo("kite"), round: wingGeo("round"), swallow: wingGeo("swallow") };

const INK = "#0c1122";
const CREAM = "#f1ead8";
const BRASS = "#c8a35a";
const LANTERN = "#ffb257";

/** Part ids used by hatch.vert. */
export const P = { body: 0, head: 1, ear: 2, tail: 3, wing: 4, leg: 5, eye: 6, koi: 7, gear: 8 } as const;

type V3 = [number, number, number];
interface Anchors {
  headPivot: V3;
  neck: V3; neckR: number; neckAxis: "z" | "y";
  headTop: V3; side: V3;
  body: { c: V3; r: V3; axis: "z" | "y" };
  face: { c: V3; r: V3 };
  legs: { x: number; z: number; len: number; r: number; pivot: V3 }[];
  height: number;
}
interface Ctx {
  b: GeoBuilder;
  s: CreatureSpec;
  body: THREE.Color; dark: THREE.Color; accent: THREE.Color; accentDark: THREE.Color; coat: THREE.Color;
  rnd: () => number;
  /** Options for a coat-carrying part: adds the two-tone blend around height `cy` when the coat is two-tone. */
  coatOpts(o: PartOpts, cy: number): PartOpts;
}

const col = (c: Hsl, dl = 0, ks = 1) => new THREE.Color().setHSL(c.h / 360, Math.min(1, c.s * ks), Math.min(0.95, Math.max(0.05, c.l + dl)));
const up = new THREE.Vector3(0, 1, 0);
/** A matrix that points the primitive's +y along `dir`. */
function xfDir(p: V3, dir: THREE.Vector3, s: V3): THREE.Matrix4 {
  const q = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), q, new THREE.Vector3(...s));
}

// ---- species ----------------------------------------------------------------------------------------------------------------

function fox(x: Ctx, spirit: boolean): Anchors {
  const { b, s } = x;
  const bw = 0.34 * s.build;
  const legL = 0.36 + (1 - s.build) * 0.2;
  const by = legL + 0.14;
  const e = s.earSize, tl = s.tailSize;
  const glow = spirit ? 0.18 : 0;
  b.add(sphHi, xf([0, by, 0], [0, 0, 0], [bw, 0.3, 0.52]), x.coatOpts({ color: x.body, jitter: 0.05, part: P.body, emit: glow }, by));
  b.add(sph, xf([0, by - 0.08, 0.1], [0, 0, 0], [bw * 0.76, 0.2, 0.36]), { color: CREAM, part: P.body });
  const hp: V3 = [0, by + 0.22, 0.3];
  b.add(sph, xf([0, by + 0.28, 0.42], [0, 0, 0], [0.24, 0.22, 0.24]), { color: x.body, part: P.head, emit: glow });
  b.add(cone, xf([0, by + 0.22, 0.68], [Math.PI / 2, 0, 0], [0.1, 0.24, 0.1]), { color: CREAM, part: P.head });
  b.add(sph, xf([0, by + 0.23, 0.8], [0, 0, 0], 0.035), { color: INK, part: P.head });
  for (const sx of [-1, 1]) {
    const pv: V3 = [sx * 0.13, by + 0.46, 0.36];
    if (s.ears === "round") {
      b.add(sph, xf([sx * 0.15, by + 0.5 + 0.02 * e, 0.36], [0, 0, 0], [0.09 * e, 0.1 * e, 0.04]), { color: x.body, part: P.ear, pivot: pv });
      b.add(sph, xf([sx * 0.15, by + 0.5 + 0.02 * e, 0.38], [0, 0, 0], [0.055 * e, 0.065 * e, 0.02]), { color: x.dark, part: P.ear, pivot: pv });
    } else {
      const h = (s.ears === "tufted" ? 0.36 : 0.3) * e;
      b.add(cone, xf([sx * 0.13, by + 0.46 + h / 2, 0.36], [-0.15, 0, sx * -0.18], [0.1, h, 0.06]), { color: x.body, part: P.ear, pivot: pv });
      b.add(cone, xf([sx * 0.13, by + 0.44 + h / 2 - 0.02, 0.375], [-0.15, 0, sx * -0.18], [0.06, h * 0.72, 0.03]), { color: x.dark, part: P.ear, pivot: pv });
      if (s.ears === "tufted") b.add(cone, xf([sx * (0.13 + h * 0.18), by + 0.46 + h + 0.04, 0.34], [-0.15, 0, sx * -0.18], [0.03, 0.12, 0.03]), { color: INK, part: P.ear, pivot: pv });
    }
    b.add(sph, xf([sx * 0.1, by + 0.33, 0.61], [0, 0, 0], [0.032, 0.04, 0.02]), { color: INK, part: P.eye, pivot: [sx * 0.1, by + 0.33, 0.61] });
  }
  const tp: V3 = [0, by, -0.42];
  const tails = spirit ? [-0.42, 0, 0.42] : [0];
  for (const ang of tails) {
    const rotY = (p: V3): V3 => { const dx = p[0], dz = p[2] - tp[2]; return [dx * Math.cos(ang) + dz * Math.sin(ang), p[1], tp[2] - dx * Math.sin(ang) + dz * Math.cos(ang)]; };
    const tipEmit = spirit ? 0.85 : 0;
    const tailCol = spirit ? x.accent : x.body;
    if (spirit) {
      // Spirit tails: short flames that rise behind, glowing toward the tip.
      for (let i = 0; i < 4; i++) {
        const k = i / 3;
        b.add(sph, xf(rotY([0, by + 0.08 + 0.15 * i * tl, -0.56 - 0.1 * i * tl]), [0, 0, 0], [0.13 - 0.02 * i, 0.13 - 0.02 * i, 0.16 - 0.02 * i]), { color: i === 3 ? CREAM : tailCol, part: P.tail, pivot: tp, emit: 0.2 + k * 0.65 });
      }
    } else if (s.tail === "stub") {
      b.add(sph, xf(rotY([0, by + 0.08, -0.56]), [0, 0, 0], [0.14, 0.14, 0.16]), { color: tailCol, part: P.tail, pivot: tp });
      b.add(sph, xf(rotY([0, by + 0.1, -0.66]), [0, 0, 0], [0.09, 0.09, 0.1]), { color: CREAM, part: P.tail, pivot: tp, emit: tipEmit });
    } else if (s.tail === "curl") {
      const cc: V3 = [0, by + 0.28 * tl, -0.62], r = 0.26 * tl;
      for (let i = 0; i < 6; i++) {
        const a = -Math.PI / 2 + (i / 5) * Math.PI * 1.35;
        const sz = (0.17 - i * 0.015) * Math.min(1.2, tl);
        b.add(sph, xf(rotY([0, cc[1] + Math.sin(a) * r, cc[2] - Math.cos(a) * r]), [0, 0, 0], sz), { color: i === 5 ? CREAM : tailCol, part: P.tail, pivot: tp, emit: i === 5 ? tipEmit : glow });
      }
    } else {
      const plume = s.tail === "plume";
      const n = plume ? 4 : 3;
      for (let i = 0; i < n; i++) {
        const k = i / (n - 1);
        const zz = -0.6 - (plume ? 0.22 : 0.28) * tl * i;
        const yy = by + 0.05 + (plume ? 0.16 : 0.06) * tl * i * (1 + k * 0.5);
        const r = (plume ? 0.18 + 0.05 * Math.sin(k * Math.PI) : [0.16, 0.2, 0.15][i]!) * (spirit ? 0.72 : 1);
        b.add(sph, xf(rotY([0, yy, zz]), [0, 0, 0], [r, r, r * 1.4]), { color: i === n - 1 ? CREAM : tailCol, part: P.tail, pivot: tp, emit: i === n - 1 ? tipEmit : glow });
      }
    }
  }
  const legs: Anchors["legs"] = [];
  for (const [lx, lz] of [[-0.15, 0.32], [0.15, 0.32], [-0.15, -0.3], [0.15, -0.3]] as const) {
    const pivot: V3 = [lx * s.build, legL, lz];
    b.add(cyl, xf([lx * s.build, legL / 2, lz], [0, 0, 0], [0.055, legL, 0.055]), { color: x.dark, part: P.leg, pivot });
    legs.push({ x: lx * s.build, z: lz, len: legL, r: 0.055, pivot });
  }
  return {
    headPivot: hp, neck: [0, by + 0.12, 0.38], neckR: 0.2, neckAxis: "z", headTop: [0, by + 0.5, 0.42], side: [bw, by - 0.05, 0.08],
    body: { c: [0, by, 0], r: [bw, 0.3, 0.52], axis: "z" }, face: { c: [0, by + 0.32, 0.5], r: [0.22, 0.08, 0.16] }, legs, height: by + 0.6 + (spirit ? 0.1 : 0),
  };
}

function hare(x: Ctx): Anchors {
  const { b, s } = x;
  const bw = 0.3 * s.build, e = s.earSize;
  b.add(sphHi, xf([0, 0.4, -0.05], [-0.25, 0, 0], [bw, 0.3, 0.38]), x.coatOpts({ color: x.body, jitter: 0.05, part: P.body }, 0.42));
  b.add(sph, xf([0, 0.36, 0.08], [-0.25, 0, 0], [bw * 0.7, 0.22, 0.26]), { color: CREAM, part: P.body });
  const hp: V3 = [0, 0.62, 0.2];
  b.add(sph, xf([0, 0.72, 0.28], [0, 0, 0], [0.2, 0.19, 0.21]), { color: x.body, part: P.head });
  b.add(sph, xf([0, 0.68, 0.46], [0, 0, 0], [0.08, 0.06, 0.05]), { color: CREAM, part: P.head });
  b.add(sph, xf([0, 0.71, 0.5], [0, 0, 0], 0.026), { color: x.accentDark, part: P.head });
  for (const sx of [-1, 1]) {
    const pv: V3 = [sx * 0.08, 0.86, 0.24];
    if (s.ears === "lop") {
      b.add(sph, xf([sx * (0.16 + 0.1 * e), 0.74, 0.24], [0, 0, sx * (Math.PI / 2 + 0.5)], [0.055, 0.2 * e, 0.035]), { color: x.body, part: P.ear, pivot: pv });
      b.add(sph, xf([sx * (0.16 + 0.1 * e), 0.74, 0.26], [0, 0, sx * (Math.PI / 2 + 0.5)], [0.03, 0.15 * e, 0.02]), { color: x.accent, part: P.ear, pivot: pv });
    } else {
      const h = (s.ears === "round" ? 0.15 : 0.27) * e, w = s.ears === "round" ? 0.075 : 0.055;
      b.add(sph, xf([sx * 0.08, 0.86 + h, 0.22], [0, 0, sx * -0.12], [w, h, 0.035]), { color: x.body, part: P.ear, pivot: pv });
      b.add(sph, xf([sx * 0.08, 0.86 + h, 0.245], [0, 0, sx * -0.12], [w * 0.55, h * 0.78, 0.02]), { color: x.accent, part: P.ear, pivot: pv });
    }
    b.add(sph, xf([sx * 0.11, 0.77, 0.42], [0, 0, 0], [0.03, 0.038, 0.02]), { color: INK, part: P.eye, pivot: [sx * 0.11, 0.77, 0.42] });
  }
  const tp: V3 = [0, 0.4, -0.4];
  const t = s.tailSize;
  b.add(sph, xf([0, 0.44, -0.46], [0, 0, 0], 0.09 * t), { color: CREAM, part: P.tail, pivot: tp });
  if (s.tail === "curl") b.add(sph, xf([0, 0.53, -0.48], [0, 0, 0], 0.06 * t), { color: CREAM, part: P.tail, pivot: tp });
  const legs: Anchors["legs"] = [];
  for (const sx of [-1, 1]) {
    const hpv: V3 = [sx * 0.17, 0.2, -0.1];
    b.add(sph, xf([sx * 0.17 * s.build, 0.06, -0.06], [0, 0, 0], [0.07, 0.06, 0.2]), { color: x.dark, part: P.leg, pivot: hpv });
    const fpv: V3 = [sx * 0.1, 0.22, 0.24];
    b.add(cyl, xf([sx * 0.1, 0.11, 0.24], [0, 0, 0], [0.045, 0.22, 0.045]), { color: x.dark, part: P.leg, pivot: fpv });
    legs.push({ x: sx * 0.1, z: 0.24, len: 0.22, r: 0.045, pivot: fpv });
  }
  return {
    headPivot: hp, neck: [0, 0.6, 0.24], neckR: 0.16, neckAxis: "z", headTop: [0, 0.9, 0.3], side: [bw, 0.38, 0.02],
    body: { c: [0, 0.4, -0.05], r: [bw, 0.3, 0.38], axis: "z" }, face: { c: [0, 0.77, 0.38], r: [0.19, 0.06, 0.1] }, legs, height: 1.05 + 0.2 * e,
  };
}

function beetle(x: Ctx): Anchors {
  const { b, s } = x;
  const bw = 0.44 * s.build;
  b.add(dome, xf([0, 0.26, 0], [0, 0, 0], [bw, 0.4, 0.5]), x.coatOpts({ color: x.body, jitter: 0.04, part: P.body }, 0.46));
  b.add(cyl, xf([0, 0.2, 0], [0, 0, 0], [bw * 0.95, 0.12, 0.48]), { color: x.dark, part: P.body });
  b.add(box, xf([0, 0.62, 0], [0, 0, 0], [0.012, 0.1, 0.9]), { color: INK, part: P.body });
  const hp: V3 = [0, 0.28, 0.4];
  b.add(sph, xf([0, 0.28, 0.5], [0, 0, 0], [0.19, 0.16, 0.18]), { color: x.dark, part: P.head });
  const e = s.earSize;
  for (const sx of [-1, 1]) {
    b.add(sph, xf([sx * 0.09, 0.33, 0.64], [0, 0, 0], 0.035), { color: CREAM, part: P.eye, pivot: [sx * 0.09, 0.33, 0.64] });
    b.add(cone, xf([sx * 0.08, 0.22, 0.7], [Math.PI / 2, 0, sx * 0.4], [0.03, 0.16, 0.03]), { color: INK, part: P.head });
    b.add(cyl, xf([sx * 0.3, 0.16, 0.42], [Math.PI / 2, 0, sx * 0.3], [0.03, 0.3, 0.03]), { color: x.dark, part: P.leg, pivot: [sx * 0.3, 0.2, 0.34] });
    b.add(box, xf([sx * 0.36, 0.14, 0.6], [0, 0, 0], [0.08, 0.05, 0.1]), { color: BRASS, part: P.leg, pivot: [sx * 0.3, 0.2, 0.34] });
    const pv: V3 = [sx * 0.08, 0.4, 0.56];
    if (s.ears === "lop") for (let i = 0; i < 4; i++) b.add(sph, xf([sx * (0.08 + i * 0.05 * e), 0.42 + i * 0.07 * e - i * i * 0.012, 0.6 + i * 0.05], [0, 0, 0], 0.022), { color: INK, part: P.ear, pivot: pv });
    if (s.ears === "tufted") b.add(cone, xf([sx * 0.1, 0.5 + 0.08 * e, 0.56], [0.3, 0, sx * -0.5], [0.035, 0.22 * e, 0.035]), { color: x.accentDark, part: P.ear, pivot: pv });
  }
  if (s.ears === "pointed") b.add(cone, xf([0, 0.46 + 0.06 * e, 0.62], [0.6, 0, 0], [0.05, 0.26 * e, 0.05]), { color: x.accentDark, part: P.head });
  b.add(cyl, xf([0, 0.68, -0.02], [0, 0, 0], [0.14, 0.05, 0.14]), { color: BRASS, emit: 0.06, part: P.gear, pivot: [0, 0.68, -0.02] });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    b.add(box, xf([Math.cos(a) * 0.16, 0.68, -0.02 + Math.sin(a) * 0.16], [0, -a, 0], [0.05, 0.05, 0.045]), { color: BRASS, part: P.gear, pivot: [0, 0.68, -0.02] });
  }
  const legs: Anchors["legs"] = [];
  for (const [lx, lz] of [[-1, 0.15], [1, 0.15], [-1, -0.1], [1, -0.1], [-1, -0.3], [1, -0.3]] as const) {
    b.add(cyl, xf([lx * 0.36 * s.build, 0.1, lz], [0, 0, lx * 0.6], [0.028, 0.26, 0.028]), { color: INK, part: P.leg, pivot: [lx * 0.36, 0.2, lz] });
  }
  return {
    headPivot: hp, neck: [0, 0.3, 0.42], neckR: 0.17, neckAxis: "z", headTop: [0, 0.44, 0.5], side: [bw, 0.26, 0.05],
    body: { c: [0, 0.26, 0], r: [bw, 0.4, 0.5], axis: "z" }, face: { c: [0, 0.32, 0.56], r: [0.17, 0.05, 0.1] }, legs, height: 0.85,
  };
}

function hedgehog(x: Ctx): Anchors {
  const { b, s, rnd } = x;
  const bw = 0.34 * s.build;
  const c: V3 = [0, 0.3, -0.02];
  b.add(sphHi, xf(c, [0, 0, 0], [bw, 0.27, 0.42]), x.coatOpts({ color: x.dark, jitter: 0.08, part: P.body }, 0.34));
  b.add(sph, xf([0, 0.24, 0.1], [0, 0, 0], [bw * 0.8, 0.18, 0.34]), { color: x.body, part: P.body });
  const spineCol = col(s.body, -0.28, 0.7);
  for (let row = 0; row < 5; row++) {
    const th = 0.2 + row * 0.26;
    const nn = 6 + row * 2;
    for (let i = 0; i < nn; i++) {
      const ph = Math.PI * (0.05 + (i / (nn - 1)) * 0.9) + (rnd() - 0.5) * 0.12;
      const d = new THREE.Vector3(Math.sin(th) * Math.cos(ph) * 1.0, Math.cos(th), -Math.sin(th) * Math.sin(ph));
      if (d.z > 0.55) continue;
      const p: V3 = [c[0] + d.x * bw * 0.92, c[1] + d.y * 0.27 * 0.92, c[2] + d.z * 0.42 * 0.92];
      const dir = new THREE.Vector3(d.x, d.y + 0.25, d.z - 0.35);
      b.add(cone, xfDir([p[0] + dir.x * 0.05, p[1] + dir.y * 0.05, p[2] + dir.z * 0.05], dir, [0.035, 0.17, 0.035]), { color: spineCol, part: P.body });
    }
  }
  const hp: V3 = [0, 0.28, 0.3];
  b.add(sph, xf([0, 0.28, 0.38], [0, 0, 0], [0.17, 0.15, 0.18]), { color: x.body, part: P.head });
  b.add(cone, xf([0, 0.25, 0.54], [Math.PI / 2, 0, 0], [0.07, 0.14, 0.07]), { color: x.body, part: P.head });
  b.add(sph, xf([0, 0.25, 0.62], [0, 0, 0], 0.03), { color: INK, part: P.head });
  for (const sx of [-1, 1]) {
    b.add(sph, xf([sx * 0.08, 0.34, 0.5], [0, 0, 0], [0.026, 0.032, 0.018]), { color: INK, part: P.eye, pivot: [sx * 0.08, 0.34, 0.5] });
    b.add(sph, xf([sx * 0.13, 0.42, 0.36], [0, 0, 0], [0.05 * s.earSize, 0.05 * s.earSize, 0.025]), { color: x.body, part: P.ear, pivot: [sx * 0.12, 0.4, 0.36] });
  }
  const legs: Anchors["legs"] = [];
  for (const [lx, lz] of [[-0.16, 0.2], [0.16, 0.2], [-0.16, -0.22], [0.16, -0.22]] as const) {
    const pivot: V3 = [lx, 0.12, lz];
    b.add(cyl, xf([lx, 0.06, lz], [0, 0, 0], [0.04, 0.12, 0.04]), { color: x.accentDark, part: P.leg, pivot });
    legs.push({ x: lx, z: lz, len: 0.12, r: 0.04, pivot });
  }
  b.add(sph, xf([0, 0.26, -0.44], [0, 0, 0], 0.04 * s.tailSize), { color: x.body, part: P.tail, pivot: [0, 0.26, -0.4] });
  return {
    headPivot: hp, neck: [0, 0.22, 0.36], neckR: 0.17, neckAxis: "z", headTop: [0, 0.58, 0.02], side: [bw, 0.28, 0.05],
    body: { c, r: [bw, 0.27, 0.42], axis: "z" }, face: { c: [0, 0.33, 0.44], r: [0.16, 0.05, 0.1] }, legs, height: 0.75,
  };
}

function owl(x: Ctx): Anchors {
  const { b, s } = x;
  const bw = 0.3 * s.build;
  b.add(sphHi, xf([0, 0.52, 0], [0, 0, 0], [bw, 0.4, 0.28]), x.coatOpts({ color: x.body, jitter: 0.05, part: P.body }, 0.62));
  b.add(sph, xf([0, 0.47, 0.1], [0, 0, 0], [bw * 0.72, 0.3, 0.2]), { color: col(s.body, 0.22, 0.5), part: P.body });
  const hp: V3 = [0, 0.84, 0];
  b.add(sphHi, xf([0, 0.96, 0.02], [0, 0, 0], [0.27, 0.23, 0.25]), { color: x.body, part: P.head });
  for (const sx of [-1, 1]) {
    b.add(sph, xf([sx * 0.1, 0.97, 0.2], [0, 0, 0], [0.11, 0.11, 0.06]), { color: col(s.accent, 0.12, 0.6), part: P.head });
    b.add(sph, xf([sx * 0.1, 0.98, 0.25], [0, 0, 0], [0.055, 0.055, 0.03]), { color: INK, part: P.eye, pivot: [sx * 0.1, 0.98, 0.25] });
    b.add(sph, xf([sx * 0.085, 1.0, 0.275], [0, 0, 0], 0.014), { color: CREAM, part: P.eye, pivot: [sx * 0.1, 0.98, 0.25] });
    const pv: V3 = [sx * 0.15, 1.12, 0.02];
    if (s.ears === "tufted") b.add(cone, xf([sx * 0.17, 1.18 + 0.05 * s.earSize, 0.02], [0, 0, sx * -0.35], [0.05, 0.18 * s.earSize, 0.04]), { color: x.dark, part: P.ear, pivot: pv });
    const wpv: V3 = [sx * 0.27, 0.72, 0];
    const wsc: V3 = s.wings === "round" ? [0.08, 0.28, 0.24] : s.wings === "swallow" ? [0.06, 0.4, 0.19] : [0.07, 0.34, 0.22];
    b.add(sph, xf([sx * 0.3, 0.72 - wsc[1] * 0.75, -0.04], [0.15, 0, sx * 0.12], wsc), { color: x.dark, part: P.wing, pivot: wpv });
    if (s.wings === "swallow") b.add(cone, xf([sx * 0.3, 0.2, -0.12], [Math.PI, 0, sx * -0.1], [0.04, 0.16, 0.03]), { color: x.dark, part: P.wing, pivot: wpv });
    b.add(sph, xf([sx * 0.1, 0.05, 0.12], [0, 0, 0], [0.05, 0.035, 0.08]), { color: BRASS, part: P.leg, pivot: [sx * 0.1, 0.14, 0.05] });
  }
  b.add(cone, xf([0, 0.9, 0.29], [Math.PI * 0.62, 0, 0], [0.035, 0.09, 0.035]), { color: BRASS, part: P.head });
  const tp: V3 = [0, 0.3, -0.22];
  const t = s.tailSize * (s.tail === "plume" ? 1.4 : 1);
  b.add(cone, xf([0, 0.2, -0.3], [-2.4, 0, 0], [0.12 * t, 0.2 * t, 0.04]), { color: x.dark, part: P.tail, pivot: tp });
  return {
    headPivot: hp, neck: [0, 0.78, 0.02], neckR: 0.24, neckAxis: "y", headTop: [0, 1.2, 0.02], side: [bw + 0.06, 0.5, 0.06],
    body: { c: [0, 0.52, 0], r: [bw, 0.4, 0.28], axis: "y" }, face: { c: [0, 0.99, 0.2], r: [0.24, 0.08, 0.08] }, legs: [], height: 1.3,
  };
}

function koi(x: Ctx): Anchors {
  const { b, s } = x;
  const segs: [number, number, number][] = [[0.62, 0.22, 0.24], [0.28, 0.27, 0.32], [-0.08, 0.25, 0.32], [-0.42, 0.19, 0.26], [-0.7, 0.13, 0.2]];
  const light = col(s.body, 0.18);
  segs.forEach(([z, r, l], i) => {
    b.add(sphHi, xf([0, 0.5, z], [0, 0, 0], [r * s.build, r * 0.9, l]), x.coatOpts({ color: i % 2 ? x.body : light, jitter: 0.05, part: P.koi, pivot: [0, 0.5, z] }, 0.55));
  });
  b.add(sph, xf([0.09, 0.56, 0.8], [0, 0, 0], 0.035), { color: INK, part: P.eye, pivot: [0.09, 0.56, 0.8] });
  b.add(sph, xf([-0.09, 0.56, 0.8], [0, 0, 0], 0.035), { color: INK, part: P.eye, pivot: [-0.09, 0.56, 0.8] });
  const t = s.tailSize;
  if (s.tail === "curl") for (const sx of [-1, 1]) b.add(cone, xf([sx * 0.08, 0.5, -0.96], [-Math.PI / 2, sx * 0.5, 0], [0.12, 0.34 * t, 0.03]), { color: x.accent, part: P.koi, pivot: [0, 0.5, -0.95] });
  else b.add(cone, xf([0, 0.5, -0.9 - 0.12 * t * (s.tail === "plume" ? 1.6 : 1)], [-Math.PI / 2, 0, 0], [0.22 * (s.tail === "plume" ? 1.3 : 1), 0.34 * t * (s.tail === "plume" ? 1.6 : s.tail === "stub" ? 0.6 : 1), 0.03]), { color: x.accent, part: P.koi, pivot: [0, 0.5, -0.95] });
  b.add(cone, xf([0, 0.75, 0.1], [0, 0, 0], [0.03, 0.2, 0.3]), { color: x.accent, part: P.koi, pivot: [0, 0.5, 0.1] });
  for (const sx of [-1, 1]) b.add(cone, xf([sx * 0.26, 0.42, 0.35], [0, 0, sx * -1.2], [0.05, 0.22, 0.12]), { color: x.accent, part: P.koi, pivot: [0, 0.5, 0.3] });
  b.add(cyl, xf([0, 0.76, -0.1], [0, 0, 0], [0.1, 0.05, 0.1]), { color: BRASS, part: P.gear, pivot: [0, 0.76, -0.1] });
  return {
    headPivot: [0, 0.5, 0.5], neck: [0, 0.5, 0.42], neckR: 0.26, neckAxis: "z", headTop: [0, 0.72, 0.56], side: [0.28, 0.5, 0],
    body: { c: [0, 0.5, -0.05], r: [0.27 * s.build, 0.24, 0.7], axis: "z" }, face: { c: [0, 0.56, 0.72], r: [0.2, 0.06, 0.1] }, legs: [], height: 0.95,
  };
}

function moth(x: Ctx): Anchors {
  const { b, s } = x;
  const w = WINGS[s.wings];
  b.add(sph, xf([0, 0.92, 0], [0, 0, 0], [0.12 * s.build, 0.12, 0.26]), x.coatOpts({ color: x.body, part: P.body }, 0.95));
  b.add(sph, xf([0, 0.86, -0.32], [0, 0, 0], [0.16 * s.build, 0.16, 0.28]), { color: col(s.body, 0.12, 1.3), emit: 0.55, part: P.body });
  const hp: V3 = [0, 0.95, 0.2];
  b.add(sph, xf([0, 0.98, 0.26], [0, 0, 0], 0.11), { color: x.body, part: P.head });
  for (const sx of [-1, 1]) {
    b.add(sph, xf([sx * 0.07, 1.0, 0.34], [0, 0, 0], 0.045), { color: INK, part: P.eye, pivot: [sx * 0.07, 1.0, 0.34] });
    const e = s.earSize;
    b.add(cone, xf([sx * 0.06, 1.1 + 0.06 * e, 0.33], [-0.5, 0, sx * -0.35], [0.012, 0.22 * e, 0.012]), { color: x.dark, part: P.ear, pivot: [sx * 0.04, 1.02, 0.3] });
    if (s.ears === "tufted") for (let i = 1; i <= 3; i++) b.add(sph, xf([sx * (0.06 + i * 0.022 * e), 1.04 + i * 0.05 * e, 0.36 + i * 0.03 * e], [0, 0, 0], 0.02), { color: x.accent, part: P.ear, pivot: [sx * 0.04, 1.02, 0.3] });
    b.add(w, xf([sx * 0.06, 0.98, 0.04], [Math.PI / 2, 0, sx > 0 ? 0 : Math.PI], [0.8, 1.0, 1]), { color: x.accent, jitter: 0.06, part: P.wing, pivot: [sx * 0.06, 0.95, 0.02] });
    b.add(w, xf([sx * 0.06, 0.93, -0.16], [Math.PI / 2, 0, sx > 0 ? 0 : Math.PI], [0.55, 0.75, 1]), { color: x.accentDark, part: P.wing, pivot: [sx * 0.06, 0.93, -0.1] });
    b.add(sph, xf([sx * 0.45, 0.99, -0.02], [0, 0, 0], [0.08, 0.012, 0.08]), { color: x.coat, part: P.wing, pivot: [sx * 0.06, 0.95, 0.02] });
    if (s.wings === "swallow") b.add(cone, xf([sx * 0.42, 0.93, -0.6], [-Math.PI / 2, 0, 0], [0.03, 0.26, 0.012]), { color: x.accentDark, part: P.wing, pivot: [sx * 0.06, 0.93, -0.1] });
  }
  return {
    headPivot: hp, neck: [0, 0.92, 0.18], neckR: 0.12, neckAxis: "z", headTop: [0, 1.1, 0.26], side: [0.14, 0.84, -0.12],
    body: { c: [0, 0.9, -0.1], r: [0.13, 0.13, 0.38], axis: "z" }, face: { c: [0, 1.01, 0.33], r: [0.1, 0.04, 0.05] }, legs: [], height: 1.3,
  };
}

function salamander(x: Ctx): Anchors {
  const { b, s } = x;
  const bw = s.build;
  const segs: [number, number, number][] = [[0.3, 0.13, 0.17], [0.06, 0.15, 0.19], [-0.2, 0.14, 0.18], [-0.42, 0.1, 0.15]];
  segs.forEach(([z, r, l]) => b.add(sphHi, xf([0, 0.2, z], [0, 0, 0], [r * 1.25 * bw, r, l]), x.coatOpts({ color: x.body, jitter: 0.06, part: P.koi, pivot: [0, 0.2, z] }, 0.24)));
  for (let i = 0; i < 6; i++) b.add(sph, xf([0, 0.33 - Math.abs(i - 2) * 0.01, 0.3 - i * 0.14], [0, 0, 0], [0.025, 0.03, 0.04]), { color: x.accent, part: P.koi, pivot: [0, 0.2, 0.3 - i * 0.14], emit: 0.15 });
  const hp: V3 = [0, 0.2, 0.4];
  b.add(sph, xf([0, 0.22, 0.52], [0, 0, 0], [0.16, 0.1, 0.19]), { color: x.body, part: P.head });
  for (const sx of [-1, 1]) {
    b.add(sph, xf([sx * 0.085, 0.3, 0.56], [0, 0, 0], [0.035, 0.035, 0.03]), { color: INK, part: P.eye, pivot: [sx * 0.085, 0.3, 0.56] });
    if (s.ears === "tufted") for (let i = 0; i < 3; i++) b.add(cone, xf([sx * (0.16 + i * 0.01), 0.24 + (i - 1) * 0.05, 0.44], [0, 0, sx * (-1.2 - (i - 1) * 0.35)], [0.022, 0.1 * s.earSize, 0.018]), { color: x.accent, part: P.ear, pivot: [sx * 0.14, 0.24, 0.44], emit: 0.2 });
  }
  const tp: V3 = [0, 0.2, -0.5];
  const t = s.tailSize;
  for (let i = 0; i < 5; i++) {
    const k = (i + 1) / 5;
    const curlX = s.tail === "curl" ? Math.sin(k * Math.PI * 0.9) * 0.22 * t : 0;
    b.add(sph, xf([curlX, 0.19 - k * 0.06, -0.55 - k * 0.5 * t], [0, 0, 0], [0.09 * (1 - k * 0.7), 0.07 * (1 - k * 0.6), 0.12]), { color: i === 4 ? x.accent : x.body, part: P.tail, pivot: tp });
  }
  const legs: Anchors["legs"] = [];
  for (const [lx, lz] of [[-1, 0.24], [1, 0.24], [-1, -0.3], [1, -0.3]] as const) {
    const pivot: V3 = [lx * 0.14, 0.18, lz];
    b.add(cyl, xf([lx * 0.24 * bw, 0.1, lz], [0, 0, lx * 1.0], [0.035, 0.22, 0.035]), { color: x.dark, part: P.leg, pivot });
    b.add(sph, xf([lx * 0.33 * bw, 0.03, lz + 0.03], [0, 0, 0], [0.05, 0.02, 0.05]), { color: x.dark, part: P.leg, pivot });
    legs.push({ x: lx * 0.3 * bw, z: lz, len: 0.08, r: 0.035, pivot });
  }
  return {
    headPivot: hp, neck: [0, 0.22, 0.4], neckR: 0.15, neckAxis: "z", headTop: [0, 0.32, 0.5], side: [0.2 * bw, 0.2, -0.1],
    body: { c: [0, 0.2, -0.05], r: [0.18 * bw, 0.14, 0.5], axis: "z" }, face: { c: [0, 0.28, 0.58], r: [0.14, 0.035, 0.08] }, legs, height: 0.6,
  };
}

// ---- shared coats, accessories, charms --------------------------------------------------------------------------------------

function patterns(x: Ctx, a: Anchors) {
  const { b, s, rnd } = x;
  const { c, r, axis } = a.body;
  switch (s.coat.pattern) {
    case "stripes": {
      const n = Math.max(2, s.coat.count);
      for (let i = 0; i < n; i++) {
        const k = -0.62 + (1.24 * (i + 0.5)) / n;
        const f = Math.sqrt(Math.max(0.05, 1 - k * k)) * 1.04;
        const p: V3 = axis === "z" ? [c[0], c[1], c[2] + k * r[2]] : [c[0], c[1] + k * r[1], c[2]];
        const sc: V3 = axis === "z" ? [r[0] * f, r[1] * f, 0.028] : [r[0] * f, 0.028, r[2] * f];
        b.add(sph, xf(p, [0, 0, 0], sc), { color: x.coat, part: s.species === "koi" || s.species === "salamander" ? P.koi : P.body, pivot: p });
      }
      break;
    }
    case "speckles": {
      for (let i = 0; i < s.coat.count; i++) {
        const th = 0.2 + rnd() * 1.0, ph = rnd() * Math.PI * 2;
        const d = axis === "z" ? [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)] : [Math.sin(th) * Math.cos(ph), Math.sin(th) * Math.sin(ph), Math.cos(th)];
        const p: V3 = [c[0] + d[0]! * r[0] * 0.97, c[1] + d[1]! * r[1] * 0.97, c[2] + d[2]! * r[2] * 0.97];
        b.add(sph, xf(p, [0, 0, 0], 0.035 + rnd() * 0.025), { color: x.coat, part: s.species === "koi" || s.species === "salamander" ? P.koi : P.body, pivot: p, emit: s.effect === "glow" ? 0.5 : 0 });
      }
      break;
    }
    case "socks":
      for (const l of a.legs) b.add(cyl, xf([l.x, l.len * 0.2, l.z], [0, 0, 0], [l.r * 1.3, l.len * 0.4, l.r * 1.3]), { color: x.coat, part: P.leg, pivot: l.pivot });
      if (!a.legs.length) b.add(sph, xf([c[0], c[1] - r[1] * 0.55, c[2] + (axis === "z" ? r[2] * 0.3 : r[2] * 0.4)], [0, 0, 0], [r[0] * 0.6, r[1] * 0.25, r[2] * 0.4]), { color: x.coat, part: P.body });
      break;
    case "mask":
      b.add(sph, xf(a.face.c, [0, 0, 0], a.face.r), { color: x.coat, part: P.head });
      break;
    default: break;
  }
}

function extras(x: Ctx, a: Anchors) {
  const { b, s } = x;
  const [nx, ny, nz] = a.neck;
  const green = col({ h: 95, s: 0.45, l: 0.42 });
  for (const acc of s.accessories) {
    if (acc === "scarf") {
      b.add(torus, xf(a.neck, a.neckAxis === "z" ? [0.35, 0, 0] : [Math.PI / 2, 0, 0], [a.neckR, a.neckR, a.neckR * 0.9]), { color: x.accent, jitter: 0.05, part: P.body });
      b.add(box, xf([nx + a.neckR * 0.7, ny - 0.1, nz + (a.neckAxis === "z" ? 0 : a.neckR * 0.5)], [0.2, 0, 0.25], [0.07, 0.18, 0.025]), { color: x.accent, part: P.body });
    }
    if (acc === "leaf") {
      const [hx, hy, hz] = a.headTop;
      b.add(sph, xf([hx + 0.05, hy + 0.02, hz], [0.2, 0.6, 0.35], [0.11, 0.014, 0.05]), { color: green, part: P.head });
      b.add(cyl, xf([hx - 0.04, hy + 0.01, hz - 0.03], [0, 0, 0.6], [0.007, 0.06, 0.007]), { color: col({ h: 90, s: 0.4, l: 0.3 }), part: P.head });
    }
    if (acc === "flower") {
      const [hx, hy, hz] = a.headTop;
      const fx = hx - 0.08, fy = hy, fz = hz + 0.02;
      for (let i = 0; i < 5; i++) { const an = (i / 5) * Math.PI * 2; b.add(sph, xf([fx + Math.cos(an) * 0.04, fy + 0.01, fz + Math.sin(an) * 0.04], [0, 0, 0], [0.032, 0.014, 0.032]), { color: "#f4a9c0", part: P.head }); }
      b.add(sph, xf([fx, fy + 0.02, fz], [0, 0, 0], 0.022), { color: "#ffd36b", part: P.head, emit: 0.1 });
    }
    if (acc === "lantern") {
      const [sx, sy, sz] = a.side;
      const lx = sx + 0.07, ly = Math.max(0.16, sy - 0.12), lz = sz + 0.1;
      b.add(cyl, xf([lx, ly + 0.11, lz], [0, 0, 0], [0.006, 0.12, 0.006]), { color: INK, part: P.body });
      b.add(sph, xf([lx, ly, lz], [0, 0, 0], [0.055, 0.07, 0.055]), { color: LANTERN, part: P.body, emit: 0.95 });
      b.add(cyl, xf([lx, ly + 0.07, lz], [0, 0, 0], [0.04, 0.025, 0.04]), { color: x.accentDark, part: P.body });
    }
    if (acc === "acorn") {
      const [sx, , sz] = a.side;
      const ax = -sx - 0.05, ay = s.species === "koi" || s.species === "moth" ? a.side[1] : 0.06, az = sz + 0.22;
      b.add(sph, xf([ax, ay, az], [0, 0, 0], [0.045, 0.058, 0.045]), { color: "#a8743f", part: P.body });
      b.add(dome, xf([ax, ay + 0.02, az], [0, 0, 0], [0.05, 0.035, 0.05]), { color: "#6b4a2a", part: P.body });
    }
  }
  // The extension's charm, on the chest.
  if (s.charm.shape !== "none") {
    const cc = col({ h: s.charm.hue, s: 0.6, l: 0.62 });
    const p: V3 = a.neckAxis === "z" ? [nx, ny - a.neckR * 0.85, nz + 0.06] : [nx, ny - 0.06, nz + a.neckR * 0.95];
    const o: PartOpts = { color: cc, part: P.body, emit: 0.18 };
    switch (s.charm.shape) {
      case "bell": b.add(sph, xf(p, [0, 0, 0], 0.04), o); b.add(sph, xf([p[0], p[1] - 0.03, p[2] + 0.02], [0, 0, 0], 0.012), { ...o, color: INK }); break;
      case "star": b.add(octa, xf(p, [0, 0.4, 0.4], [0.05, 0.05, 0.02]), o); break;
      case "gear": b.add(cyl, xf(p, [Math.PI / 2, 0, 0], [0.045, 0.02, 0.045]), o); b.add(cyl, xf(p, [Math.PI / 2, 0, 0], [0.02, 0.025, 0.02]), { ...o, color: INK }); break;
      case "drop": b.add(sph, xf([p[0], p[1] - 0.01, p[2]], [0, 0, 0], 0.035), o); b.add(cone, xf([p[0], p[1] + 0.035, p[2]], [0, 0, 0], [0.03, 0.05, 0.03]), o); break;
      case "ring": b.add(torus, xf(p, [0, 0, 0], [0.035, 0.035, 0.03]), o); break;
    }
  }
}

export interface BuiltCreature {
  geometry: THREE.BufferGeometry;
  /** Head pivot in object space (after scale), for uHeadPivot. */
  headPivot: THREE.Vector3;
  /** Height of the tag anchor above the feet (after scale). */
  height: number;
}

/** One merged geometry per creature, faces +z, feet at y = 0. Reads the spec only. */
export function buildCreature(input: CreatureSpec): BuiltCreature {
  const s = sanitizeSpec(input);
  const b = new GeoBuilder(true);
  const coat = col(s.coat.color);
  const x: Ctx = {
    b, s,
    body: col(s.body), dark: col(s.body, -s.body.l * 0.55, 0.8), accent: col(s.accent), accentDark: col(s.accent, -0.14, 0.9), coat,
    rnd: stream(s.seed),
    coatOpts: (o, cy) => (s.coat.pattern === "twotone" ? { ...o, color2: coat, mix: (_x, y) => (y - cy) / 0.08 } : o),
  };
  const a = s.species === "fox" ? fox(x, false) : s.species === "spiritfox" ? fox(x, true) : s.species === "hare" ? hare(x) : s.species === "beetle" ? beetle(x)
    : s.species === "hedgehog" ? hedgehog(x) : s.species === "owl" ? owl(x) : s.species === "koi" ? koi(x) : s.species === "moth" ? moth(x) : salamander(x);
  patterns(x, a);
  extras(x, a);
  const g = b.build();
  const k = s.size;
  g.scale(k, k, k);
  // Pivots were baked before scale; scale them too.
  const pv = g.attributes.aPivot as THREE.BufferAttribute;
  for (let i = 0; i < pv.count; i++) pv.setXYZ(i, pv.getX(i) * k, pv.getY(i) * k, pv.getZ(i) * k);
  g.computeBoundingSphere();
  return { geometry: g, headPivot: new THREE.Vector3(...a.headPivot).multiplyScalar(k), height: a.height * k };
}
