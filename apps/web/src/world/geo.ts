import * as THREE from "three";

export interface PartOpts {
  color: THREE.ColorRepresentation;
  /** Foliage sway amplitude weight; "height" ramps it by world y between swayY0 and swayY0+swayH. */
  sway?: number | "height";
  swayY0?: number;
  swayH?: number;
  swayAmp?: number;
  emit?: number;
  /** Vertex colour variation, 0..1. */
  jitter?: number;
  /** Creature animation part id (see hatch.vert) and its pivot. */
  part?: number;
  pivot?: [number, number, number];
}

const tmpColor = new THREE.Color();

/** Collects transformed primitives and merges them into one non-indexed geometry. */
export class GeoBuilder {
  private parts: THREE.BufferGeometry[] = [];
  constructor(private creature = false) {}

  add(geometry: THREE.BufferGeometry, matrix: THREE.Matrix4, o: PartOpts): this {
    const g = geometry.index ? geometry.toNonIndexed() : geometry.clone();
    g.deleteAttribute("uv");
    g.applyMatrix4(matrix);
    const n = g.attributes.position!.count;
    const pos = g.attributes.position as THREE.BufferAttribute;
    const col = new Float32Array(n * 3);
    const sway = new Float32Array(n);
    const emit = new Float32Array(n).fill(o.emit ?? 0);
    tmpColor.set(o.color);
    for (let i = 0; i < n; i++) {
      const y = pos.getY(i);
      const j = o.jitter ?? 0;
      const k = 1 + j * (hash3(pos.getX(i), y, pos.getZ(i)) - 0.5) * 2;
      col[i * 3] = tmpColor.r * k;
      col[i * 3 + 1] = tmpColor.g * k;
      col[i * 3 + 2] = tmpColor.b * k;
      if (o.sway === "height") {
        const t = Math.min(1, Math.max(0, (y - (o.swayY0 ?? 0)) / (o.swayH ?? 1)));
        sway[i] = (o.swayAmp ?? 1) * t * t;
      } else sway[i] = o.sway ?? 0;
    }
    g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
    g.setAttribute("aSway", new THREE.BufferAttribute(sway, 1));
    g.setAttribute("aEmit", new THREE.BufferAttribute(emit, 1));
    if (this.creature) {
      g.setAttribute("aPart", new THREE.BufferAttribute(new Float32Array(n).fill(o.part ?? 0), 1));
      const pv = o.pivot ?? [0, 0, 0];
      const pivot = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { pivot[i * 3] = pv[0]; pivot[i * 3 + 1] = pv[1]; pivot[i * 3 + 2] = pv[2]; }
      g.setAttribute("aPivot", new THREE.BufferAttribute(pivot, 3));
    }
    this.parts.push(g);
    return this;
  }

  build(): THREE.BufferGeometry {
    const g = mergeNonIndexed(this.parts);
    for (const p of this.parts) p.dispose();
    g.computeBoundingSphere();
    return g;
  }
}

function hash3(x: number, y: number, z: number): number {
  let h = Math.imul((x * 1000) | 0, 374761393) ^ Math.imul((y * 1000) | 0, 668265263) ^ Math.imul((z * 1000) | 0, 2147483647);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

const m4 = new THREE.Matrix4();
const q = new THREE.Quaternion();
const e = new THREE.Euler();
/** Compose a matrix from position, euler rotation and scale. */
export function xf(p: [number, number, number], r: [number, number, number] = [0, 0, 0], s: [number, number, number] | number = 1): THREE.Matrix4 {
  const sc = typeof s === "number" ? [s, s, s] as const : s;
  q.setFromEuler(e.set(r[0], r[1], r[2]));
  return new THREE.Matrix4().compose(new THREE.Vector3(...p), q.clone(), new THREE.Vector3(sc[0], sc[1], sc[2]));
}
void m4;

/** Concatenate non-indexed geometries that share the same attribute set. */
function mergeNonIndexed(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  if (!parts.length) throw new Error("empty geometry");
  const out = new THREE.BufferGeometry();
  for (const name of Object.keys(parts[0]!.attributes)) {
    const first = parts[0]!.attributes[name] as THREE.BufferAttribute;
    const size = first.itemSize;
    const total = parts.reduce((a, p) => a + p.attributes[name]!.count, 0);
    const arr = new Float32Array(total * size);
    let off = 0;
    for (const p of parts) { const a = p.attributes[name] as THREE.BufferAttribute; arr.set(a.array as Float32Array, off); off += a.count * size; }
    out.setAttribute(name, new THREE.BufferAttribute(arr, size));
  }
  return out;
}
