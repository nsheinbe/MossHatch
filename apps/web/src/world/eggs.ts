import * as THREE from "three";
import { deriveTraits, fnv1a, stream } from "@mosshatch/core";
import { hatchMaterial, type Shared } from "./materials";
import { GeoBuilder, xf } from "./geo";
import { POOL_R } from "./scenery";

const eggGeo = (() => {
  const b = new GeoBuilder();
  b.add(new THREE.SphereGeometry(1, 18, 14), xf([0, 0.3, 0], [0, 0, 0], [0.24, 0.31, 0.24]), { color: "#f1ead8", jitter: 0.03 });
  const g = b.build();
  return g;
})();

/** An egg that rises through the pool surface and bobs. */
export class Egg {
  mesh: THREE.Mesh;
  private mat: THREE.ShaderMaterial;
  private t0: number;
  private seed: number;
  home = new THREE.Vector3();
  /** 0 = under water, 1 = surfaced. */
  rise = 0;
  visible = true;
  wobble = 0;
  glow = 0.06;
  sink = 0;
  constructor(shared: Shared, public domain: string, index: number, total: number, now: number) {
    const rnd = stream(fnv1a("egg:" + domain));
    this.seed = rnd() * 10;
    this.mat = hatchMaterial(shared, { look: { moss: 0.28, glow: 0.05 } });
    // Tint by hue hint so eggs read as their creature's colour family.
    const tr = deriveTraits(domain);
    this.mesh = new THREE.Mesh(eggGeo, this.mat);
    this.mesh.userData.tint = tr.hue;
    this.mesh.frustumCulled = false;
    this.t0 = now + index * 0.16;
    const span = Math.min(2.5, 0.9 + total * 0.36);
    const x = total === 1 ? 0 : -span + (2 * span * index) / (total - 1);
    this.home.set(x, 0, 0.85 - 0.28 * Math.pow(x / 2.6, 2) * 1.0);
    void POOL_R;
  }
  get uniforms() { return this.mat.uniforms; }
  update(now: number, calm: boolean) {
    const k = Math.min(1, Math.max(0, (now - this.t0) / 1.1));
    this.rise = 1 - Math.pow(1 - k, 3);
    const bob = Math.sin(now * 1.3 + this.seed) * 0.03 * (calm ? 0.4 : 1);
    const y = -1.05 + this.rise * (1.05 + 0.06) + bob * this.rise - this.sink * 1.2;
    this.mesh.position.set(this.home.x, y, this.home.z);
    this.mesh.rotation.z = Math.sin(now * 0.9 + this.seed) * 0.06 + Math.sin(now * (14 + this.wobble * 26)) * this.wobble * 0.22;
    this.mesh.rotation.x = Math.cos(now * 0.7 + this.seed) * 0.04;
    this.mesh.rotation.y += 0.002;
    this.mat.uniforms.uGlow!.value = this.glow;
    this.mesh.visible = this.visible && this.rise > 0.02;
  }
  /** Top of the egg in world space, where the chip attaches. */
  chipAnchor(out: THREE.Vector3) { return out.set(this.home.x, Math.max(0.2, this.mesh.position.y + 0.85), this.home.z); }
  dispose() { this.mat.dispose(); }
}
