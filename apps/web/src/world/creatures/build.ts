import * as THREE from "three";
import { fnv1a, stream, type Traits } from "@mosshatch/core";
import { GeoBuilder, xf } from "../geo";

const sph = new THREE.SphereGeometry(1, 14, 10);
const cone = new THREE.ConeGeometry(1, 1, 8, 1);
const cyl = new THREE.CylinderGeometry(1, 1, 1, 8);
const box = new THREE.BoxGeometry(1, 1, 1);
const dome = new THREE.SphereGeometry(1, 16, 8, 0, Math.PI * 2, 0, Math.PI / 2);
const wing = (() => {
  // Kite-shaped wing: narrow at the body (x=0), broad and rounded at the tip (x=1), swept back.
  const g = new THREE.PlaneGeometry(1, 1, 6, 4);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const u = p.getX(i) + 0.5, v = p.getY(i);
    const w = Math.sin(Math.min(1, u * 1.15) * Math.PI * 0.55) * (1 - 0.18 * u);
    p.setXYZ(i, u, v * w * 1.5 - u * 0.25, Math.sin(u * 2) * 0.03);
  }
  g.computeVertexNormals();
  return g;
})();
const INK = "#0c1122";
const CREAM = "#f1ead8";

const hsl = (h: number, s: number, l: number) => new THREE.Color().setHSL(h / 360, s, l);

/** Part ids used by hatch.vert. */
const P = { body: 0, head: 1, ear: 2, tail: 3, wing: 4, leg: 5, eye: 6, koi: 7, gear: 8 } as const;

/** One merged geometry per creature; parts are animated in the vertex shader. Faces +z. */
export function buildCreatureGeometry(t: Traits): THREE.BufferGeometry {
  const b = new GeoBuilder(true);
  const body = hsl(t.hue, t.sat, t.light);
  const dark = hsl(t.hue, t.sat * 0.8, t.light * 0.45);
  const accent = hsl(t.accentHue, 0.55, 0.62);
  const rnd = stream(fnv1a(t.domain + ":spots"));
  const s = t.size;
  switch (t.family) {
    case "fox": {
      b.add(sph, xf([0, 0.5, 0], [0, 0, 0], [0.34, 0.3, 0.52]), { color: body, jitter: 0.05, part: P.body });
      b.add(sph, xf([0, 0.42, 0.1], [0, 0, 0], [0.26, 0.2, 0.36]), { color: CREAM, part: P.body });
      b.add(sph, xf([0, 0.78, 0.42], [0, 0, 0], [0.24, 0.22, 0.24]), { color: body, part: P.head, pivot: [0, 0.72, 0.3] });
      b.add(cone, xf([0, 0.72, 0.68], [Math.PI / 2, 0, 0], [0.1, 0.24, 0.1]), { color: CREAM, part: P.head, pivot: [0, 0.72, 0.3] });
      b.add(sph, xf([0, 0.73, 0.8], [0, 0, 0], 0.035), { color: INK, part: P.head, pivot: [0, 0.72, 0.3] });
      for (const sx of [-1, 1]) {
        b.add(cone, xf([sx * 0.13, 1.03 + 0.04 * t.earLength, 0.36], [-0.15, 0, sx * -0.18], [0.1, 0.3 * t.earLength, 0.06]), { color: body, part: P.ear, pivot: [sx * 0.13, 0.96, 0.36] });
        b.add(cone, xf([sx * 0.13, 1.0 + 0.04 * t.earLength, 0.375], [-0.15, 0, sx * -0.18], [0.06, 0.22 * t.earLength, 0.03]), { color: dark, part: P.ear, pivot: [sx * 0.13, 0.96, 0.36] });
        b.add(sph, xf([sx * 0.1, 0.83, 0.61], [0, 0, 0], [0.032, 0.04, 0.02]), { color: INK, part: P.eye, pivot: [sx * 0.1, 0.83, 0.61] });
      }
      const tl = t.tailLength;
      b.add(sph, xf([0, 0.55, -0.6], [0, 0, 0], [0.16, 0.16, 0.24]), { color: body, part: P.tail, pivot: [0, 0.5, -0.42] });
      b.add(sph, xf([0, 0.62, -0.6 - 0.28 * tl], [0, 0, 0], [0.2, 0.2, 0.28]), { color: body, part: P.tail, pivot: [0, 0.5, -0.42] });
      b.add(sph, xf([0, 0.66, -0.6 - 0.56 * tl], [0, 0, 0], [0.15, 0.15, 0.22]), { color: CREAM, part: P.tail, pivot: [0, 0.5, -0.42] });
      for (const [lx, lz] of [[-0.15, 0.32], [0.15, 0.32], [-0.15, -0.3], [0.15, -0.3]] as const) {
        b.add(cyl, xf([lx, 0.18, lz], [0, 0, 0], [0.055, 0.36, 0.055]), { color: dark, part: P.leg, pivot: [lx, 0.36, lz] });
      }
      for (let i = 0; i < t.spots; i++) {
        const a = rnd() * 2 - 1, c = rnd() * 2 - 1;
        b.add(sph, xf([a * 0.22, 0.72 + (1 - Math.abs(a)) * 0.05, c * 0.34], [0, 0, 0], [0.05, 0.03, 0.05]), { color: CREAM, part: P.body });
      }
      break;
    }
    case "moth": {
      b.add(sph, xf([0, 0.92, 0], [0, 0, 0], [0.12, 0.12, 0.26]), { color: body, part: P.body });
      b.add(sph, xf([0, 0.86, -0.32], [0, 0, 0], [0.16, 0.16, 0.28]), { color: hsl(t.hue, 0.7, 0.66), emit: 0.55, part: P.body });
      b.add(sph, xf([0, 0.98, 0.26], [0, 0, 0], 0.11), { color: body, part: P.head, pivot: [0, 0.95, 0.2] });
      for (const sx of [-1, 1]) {
        b.add(sph, xf([sx * 0.07, 1.0, 0.34], [0, 0, 0], 0.045), { color: INK, part: P.eye, pivot: [sx * 0.07, 1.0, 0.34] });
        b.add(cone, xf([sx * 0.06, 1.16, 0.33], [-0.5, 0, sx * -0.35], [0.012, 0.22, 0.012]), { color: dark, part: P.head, pivot: [0, 0.95, 0.2] });
        // Two wing pairs: large forewing, small hindwing.
        b.add(wing, xf([sx * 0.06, 0.98, 0.04], [Math.PI / 2, 0, sx > 0 ? 0 : Math.PI], [0.8, 1.0, 1]), { color: accent, jitter: 0.06, part: P.wing, pivot: [sx * 0.06, 0.95, 0.02] });
        b.add(wing, xf([sx * 0.06, 0.93, -0.16], [Math.PI / 2, 0, sx > 0 ? 0 : Math.PI], [0.55, 0.75, 1]), { color: hsl(t.accentHue, 0.5, 0.5), part: P.wing, pivot: [sx * 0.06, 0.93, -0.1] });
      }
      break;
    }
    case "beetle": {
      b.add(dome, xf([0, 0.26, 0], [0, 0, 0], [0.44, 0.4, 0.5]), { color: body, jitter: 0.04, part: P.body });
      b.add(cyl, xf([0, 0.2, 0], [0, 0, 0], [0.42, 0.12, 0.48]), { color: dark, part: P.body });
      b.add(sph, xf([0, 0.28, 0.5], [0, 0, 0], [0.19, 0.16, 0.18]), { color: dark, part: P.head, pivot: [0, 0.28, 0.4] });
      for (const sx of [-1, 1]) {
        b.add(sph, xf([sx * 0.09, 0.33, 0.64], [0, 0, 0], 0.035), { color: CREAM, part: P.eye, pivot: [sx * 0.09, 0.33, 0.64] });
        b.add(cone, xf([sx * 0.08, 0.22, 0.7], [Math.PI / 2, 0, sx * 0.4], [0.03, 0.16, 0.03]), { color: INK, part: P.head, pivot: [0, 0.28, 0.4] });
        b.add(cyl, xf([sx * 0.3, 0.16, 0.42], [Math.PI / 2, 0, sx * 0.3], [0.03, 0.3, 0.03]), { color: dark, part: P.leg, pivot: [sx * 0.3, 0.2, 0.34] });
        b.add(box, xf([sx * 0.36, 0.14, 0.6], [0, 0, 0], [0.08, 0.05, 0.1]), { color: "#c8a35a", part: P.leg, pivot: [sx * 0.3, 0.2, 0.34] });
      }
      // Brass gear on the shell, teeth as boxes.
      b.add(cyl, xf([0, 0.68, -0.02], [0, 0, 0], [0.14, 0.05, 0.14]), { color: "#c8a35a", emit: 0.06, part: P.gear, pivot: [0, 0.68, -0.02] });
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        b.add(box, xf([Math.cos(a) * 0.16, 0.68, -0.02 + Math.sin(a) * 0.16], [0, -a, 0], [0.05, 0.05, 0.045]), { color: "#c8a35a", part: P.gear, pivot: [0, 0.68, -0.02] });
      }
      for (const [lx, lz] of [[-1, 0.15], [1, 0.15], [-1, -0.1], [1, -0.1], [-1, -0.3], [1, -0.3]] as const) {
        b.add(cyl, xf([lx * 0.36, 0.1, lz], [0, 0, lx * 0.6], [0.028, 0.26, 0.028]), { color: INK, part: P.leg, pivot: [lx * 0.36, 0.2, lz] });
      }
      break;
    }
    case "koi": {
      // Chained segments along z, head first. Lives under the water surface.
      const segs: [number, number, number][] = [[0.62, 0.22, 0.24], [0.28, 0.27, 0.32], [-0.08, 0.25, 0.32], [-0.42, 0.19, 0.26], [-0.7, 0.13, 0.2]];
      segs.forEach(([z, r, l], i) => {
        b.add(sph, xf([0, 0.5, z], [0, 0, 0], [r, r * 0.9, l]), { color: i % 2 ? body : hsl(t.hue, t.sat, Math.min(0.85, t.light + 0.18)), jitter: 0.05, part: P.koi, pivot: [0, 0.5, z] });
      });
      b.add(sph, xf([0.09, 0.56, 0.8], [0, 0, 0], 0.035), { color: INK, part: P.eye, pivot: [0.09, 0.56, 0.8] });
      b.add(sph, xf([-0.09, 0.56, 0.8], [0, 0, 0], 0.035), { color: INK, part: P.eye, pivot: [-0.09, 0.56, 0.8] });
      b.add(cone, xf([0, 0.5, -0.98], [-Math.PI / 2, 0, 0], [0.22, 0.34, 0.03]), { color: accent, part: P.koi, pivot: [0, 0.5, -0.95] });
      b.add(cone, xf([0, 0.75, 0.1], [0, 0, 0], [0.03, 0.2, 0.3]), { color: accent, part: P.koi, pivot: [0, 0.5, 0.1] });
      for (const sx of [-1, 1]) b.add(cone, xf([sx * 0.26, 0.42, 0.35], [0, 0, sx * -1.2], [0.05, 0.22, 0.12]), { color: accent, part: P.koi, pivot: [0, 0.5, 0.3] });
      // Clockwork ring on the back.
      b.add(cyl, xf([0, 0.76, -0.1], [0, 0, 0], [0.1, 0.05, 0.1]), { color: "#c8a35a", part: P.gear, pivot: [0, 0.76, -0.1] });
      break;
    }
  }
  const g = b.build();
  g.scale(s, s, s);
  // Pivots were baked before scale; scale them too.
  const pv = g.attributes.aPivot as THREE.BufferAttribute;
  for (let i = 0; i < pv.count; i++) pv.setXYZ(i, pv.getX(i) * s, pv.getY(i) * s, pv.getZ(i) * s);
  g.computeBoundingSphere();
  return g;
}
