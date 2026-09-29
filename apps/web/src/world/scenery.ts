import * as THREE from "three";
import { fnv1a, stream } from "@mosshatch/core";
import { GeoBuilder, xf } from "./geo";
import { hatchMaterial, type Shared, TOKENS } from "./materials";

export const POOL_R = 3.0;
export const LANTERNS: [number, number, number][] = [[-4.4, 1.7, 1.2], [4.6, 1.8, 0.4], [0.6, 1.9, -4.8]];

export interface Scenery { meshes: THREE.Mesh[]; dispose(): void }

const bankY = (r: number) => -0.62 * (1 - smooth(POOL_R - 0.05, POOL_R + 0.7, r));
function smooth(a: number, b: number, x: number) { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); }

export function groundHeight(x: number, z: number): number {
  const r = Math.hypot(x, z);
  return r < POOL_R + 0.7 ? bankY(r) : 0;
}

export function buildScenery(shared: Shared, opts: { trees: number; grass: number }): Scenery {
  const rnd = stream(fnv1a("grove-at-dusk"));
  const meshes: THREE.Mesh[] = [];
  const canopy = new THREE.Color(TOKENS.canopy);

  // Ground: annulus with a sculpted bank, plus a dark pool bed.
  const ground = new GeoBuilder();
  {
    const segs = 96, rings = 28;
    const pos: number[] = [], idx: number[] = [];
    for (let j = 0; j <= rings; j++) {
      const t = j / rings;
      const r = POOL_R - 0.1 + Math.pow(t, 1.8) * 72;
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Math.PI * 2;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const bump = Math.sin(x * 0.4) * Math.cos(z * 0.35) * 0.08 * smooth(3.5, 8, r);
        pos.push(x, bankY(r) + bump, z);
      }
    }
    for (let j = 0; j < rings; j++) for (let i = 0; i < segs; i++) {
      const a = j * (segs + 1) + i, b = a + segs + 1;
      idx.push(a, a + 1, b, a + 1, b + 1, b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    const ni = g.toNonIndexed();
    // Paint: clearing lighter, moss near the pool, dark canopy shade further out.
    const p = ni.attributes.position as THREE.BufferAttribute;
    const cols: number[] = [];
    const c = new THREE.Color();
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i), r = Math.hypot(x, z);
      const n = 0.5 + 0.5 * Math.sin(x * 0.9) * Math.cos(z * 0.8);
      c.copy(canopy).lerp(new THREE.Color("#2c5236"), 0.55 * (1 - smooth(4, 16, r)) * (0.6 + 0.4 * n));
      c.lerp(new THREE.Color("#4a6b34"), 0.25 * n * (1 - smooth(3, 9, r)));
      c.lerp(new THREE.Color("#0f1f2a"), smooth(14, 40, r) * 0.7);
      cols.push(c.r, c.g, c.b);
    }
    // Feed the painted mesh through the builder with per-vertex colour by using white and multiplying.
    const gcol = new Float32Array(cols);
    ni.setAttribute("aColor", new THREE.BufferAttribute(gcol, 3));
    ni.setAttribute("aSway", new THREE.BufferAttribute(new Float32Array(p.count), 1));
    ni.setAttribute("aEmit", new THREE.BufferAttribute(new Float32Array(p.count), 1));
    ni.deleteAttribute("uv");
    meshes.push(new THREE.Mesh(ni, hatchMaterial(shared, { look: { moss: 0.35 } })));
  }
  void ground;

  // Pool bed
  {
    const b = new GeoBuilder();
    b.add(new THREE.CylinderGeometry(POOL_R + 0.1, POOL_R + 0.1, 0.1, 48), xf([0, -0.95, 0]), { color: "#0d2a2e" });
    meshes.push(new THREE.Mesh(b.build(), hatchMaterial(shared)));
  }

  // Trees: merged, layered rings fading into fog.
  if (opts.trees > 0) {
    const b = new GeoBuilder();
    const cone = new THREE.ConeGeometry(1, 1, 7, 1);
    const trunk = new THREE.CylinderGeometry(0.16, 0.24, 1, 6);
    const ico = new THREE.IcosahedronGeometry(1, 1);
    const layers = 5;
    for (let L = 0; L < layers; L++) {
      const r0 = 11 + L * 5.5;
      const count = Math.round(opts.trees * (0.55 + L * 0.2));
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rnd() * 0.5;
        const r = r0 + rnd() * 4;
        const x = Math.cos(a) * r, z = Math.sin(a) * r;
        const h = 4.5 + rnd() * 4.5 + L * 0.7;
        const w = 1.3 + rnd() * 0.9;
        const shade = new THREE.Color().copy(canopy).lerp(new THREE.Color("#3f6b3a"), rnd() * 0.5).lerp(new THREE.Color("#1d3b44"), L * 0.14);
        b.add(trunk, xf([x, h * 0.2, z], [0, 0, 0], [1, h * 0.4, 1]), { color: "#2a2a30", jitter: 0.1 });
        if (rnd() < 0.72) {
          for (let k = 0; k < 3; k++) {
            const s = 1 - k * 0.26;
            b.add(cone, xf([x, h * (0.4 + k * 0.22), z], [0, rnd() * 3, 0], [w * s * 1.5, h * 0.42, w * s * 1.5]),
              { color: shade, jitter: 0.12, sway: "height", swayY0: h * 0.35, swayH: h * 0.9, swayAmp: 1 });
          }
        } else {
          b.add(ico, xf([x, h * 0.62, z], [0, rnd() * 3, 0], [w * 1.8, h * 0.34, w * 1.8]),
            { color: shade, jitter: 0.14, sway: "height", swayY0: h * 0.3, swayH: h * 0.7, swayAmp: 1 });
        }
      }
    }
    meshes.push(new THREE.Mesh(b.build(), hatchMaterial(shared)));
  }

  // Props: stones, lantern posts, lanterns.
  {
    const b = new GeoBuilder();
    const dodeca = new THREE.DodecahedronGeometry(1, 0);
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2 + rnd() * 0.3;
      const r = POOL_R + 0.05 + rnd() * 0.5;
      const s = 0.18 + rnd() * 0.28;
      b.add(dodeca, xf([Math.cos(a) * r, bankY(r) + s * 0.4, Math.sin(a) * r], [rnd() * 3, rnd() * 3, rnd() * 3], [s * 1.3, s * 0.8, s]),
        { color: new THREE.Color("#5a6577").lerp(new THREE.Color("#7d8798"), rnd()), jitter: 0.1 });
    }
    for (let i = 0; i < 9; i++) {
      const a = Math.PI + 0.35 + rnd() * (Math.PI - 0.7), r = 6 + rnd() * 9, s = 0.5 + rnd() * 0.9;
      b.add(dodeca, xf([Math.cos(a) * r, s * 0.25, Math.sin(a) * r], [rnd() * 3, rnd() * 3, 0], [s * 1.4, s * 0.8, s]),
        { color: new THREE.Color("#4b5568").lerp(new THREE.Color("#6a7386"), rnd()), jitter: 0.1 });
    }
    const post = new THREE.CylinderGeometry(0.05, 0.07, 1, 6);
    const lantern = new THREE.CylinderGeometry(0.28, 0.24, 0.5, 8);
    const cap = new THREE.ConeGeometry(0.34, 0.2, 8);
    for (const [x, y, z] of LANTERNS) {
      b.add(post, xf([x, y * 0.5 - 0.12, z], [0, 0, 0], [1, y + 0.3, 1]), { color: "#3a2e2a" });
      b.add(lantern, xf([x, y - 0.2, z]), { color: TOKENS.lantern, emit: 0.55, sway: 0.6 });
      b.add(cap, xf([x, y + 0.15, z]), { color: "#2a2020", sway: 0.6 });
    }
    meshes.push(new THREE.Mesh(b.build(), hatchMaterial(shared)));
  }

  // Grass tufts: merged blades with tip sway.
  {
    const b = new GeoBuilder();
    const blade = new THREE.ConeGeometry(0.035, 1, 3, 1);
    for (let i = 0; i < opts.grass; i++) {
      const a = rnd() * Math.PI * 2, r = POOL_R + 0.5 + Math.pow(rnd(), 0.8) * 5.5;
      const x = Math.cos(a) * r, z = Math.sin(a) * r;
      const h = 0.25 + rnd() * 0.45;
      b.add(blade, xf([x, groundHeight(x, z) + h * 0.5, z], [(rnd() - 0.5) * 0.4, rnd() * 3, (rnd() - 0.5) * 0.4], [1, h, 1]),
        { color: new THREE.Color("#3b6a3a").lerp(new THREE.Color(TOKENS.moss), rnd() * 0.45), jitter: 0.1, sway: "height", swayY0: groundHeight(x, z), swayH: h, swayAmp: 2.2 });
    }
    meshes.push(new THREE.Mesh(b.build(), hatchMaterial(shared)));
  }

  for (const m of meshes) { m.frustumCulled = false; m.matrixAutoUpdate = false; m.updateMatrix(); }
  return {
    meshes,
    dispose() { for (const m of meshes) { m.geometry.dispose(); (m.material as THREE.Material).dispose(); } },
  };
}
