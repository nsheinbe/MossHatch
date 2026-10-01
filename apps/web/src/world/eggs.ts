import * as THREE from "three";
import { CRACKS, EGG_PATTERNS, fnv1a, sanitizeSpec, stream, type CreatureSpec, type Hsl } from "@mosshatch/core";
import { hatchMaterial, type Shared } from "./materials";
import { GeoBuilder, xf } from "./geo";
import { POOL_R } from "./scenery";

const eggGeo = (() => {
  const b = new GeoBuilder();
  b.add(new THREE.SphereGeometry(1, 22, 16), xf([0, 0.3, 0], [0, 0, 0], [0.24, 0.31, 0.24]), { color: "#f1ead8", jitter: 0.03 });
  const g = b.build();
  return g;
})();

const hslColor = (c: Hsl) => new THREE.Color().setHSL(c.h / 360, c.s, c.l);

/** An egg that rises through the pool surface and bobs. Its shell (colour, pattern, crack shape) comes from the spec's hatch look. */
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
  /** 0..1 crack progress, set by the hatch sequence. */
  crack = 0;
  /** 0..1 opacity, for the calm fade. */
  alpha = 1;
  readonly spec: CreatureSpec;
  /** Resting glow from the spec; the hatch sequence raises it. */
  readonly baseGlow: number;
  constructor(shared: Shared, public domain: string, spec: CreatureSpec, index: number, total: number, now: number) {
    const rnd = stream(fnv1a("egg:" + domain));
    this.seed = rnd() * 10;
    this.spec = sanitizeSpec(spec);
    const shell = this.spec.choreography.hatch.shell;
    this.baseGlow = 0.02 + shell.glow * 0.4;
    this.glow = this.baseGlow;
    this.mat = hatchMaterial(shared, { egg: true, look: { moss: 0.28, glow: this.baseGlow } });
    const u = this.mat.uniforms;
    u.uShellA!.value.copy(hslColor(shell.base));
    u.uShellB!.value.copy(hslColor(shell.mark));
    u.uShellPat!.value = EGG_PATTERNS.indexOf(shell.pattern);
    u.uCrackKind!.value = CRACKS.indexOf(this.spec.choreography.hatch.crack);
    this.mesh = new THREE.Mesh(eggGeo, this.mat);
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
    this.mat.uniforms.uCrack!.value = this.crack;
    const fading = this.alpha < 0.999;
    if (this.mat.transparent !== fading) { this.mat.transparent = fading; this.mat.depthWrite = !fading; this.mat.needsUpdate = true; }
    this.mat.uniforms.uAlpha!.value = this.alpha;
    this.mesh.visible = this.visible && this.rise > 0.02 && this.alpha > 0.01;
  }
  /** Top of the egg in world space, where the chip attaches. */
  chipAnchor(out: THREE.Vector3) { return out.set(this.home.x, Math.max(0.2, this.mesh.position.y + 0.85), this.home.z); }
  dispose() { this.mat.dispose(); }
}
