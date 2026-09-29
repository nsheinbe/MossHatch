import * as THREE from "three";
import { deriveTraits, fnv1a, mossFromAge, stream, type CreatureState, type Traits } from "@mosshatch/core";
import { hatchMaterial, type Shared } from "../materials";
import { buildCreatureGeometry } from "./build";
import { groundHeight, POOL_R } from "../scenery";

const geometryCache = new Map<string, THREE.BufferGeometry>();
function geometryFor(t: Traits) {
  let g = geometryCache.get(t.domain);
  if (!g) { g = buildCreatureGeometry(t); geometryCache.set(t.domain, g); }
  return g;
}

const SPEED: Record<string, number> = { fox: 0.9, beetle: 0.55, moth: 1.1, koi: 0.6 };
const _v = new THREE.Vector3();

export interface CreatureInit {
  domain: string;
  state: CreatureState;
  ageDays: number;
  x?: number; z?: number; heading?: number;
  wander?: boolean;
}

export class Creature {
  readonly traits: Traits;
  readonly mesh: THREE.Mesh;
  state: CreatureState;
  wander: boolean;
  /** Position on the ground plane; y is derived. */
  pos = new THREE.Vector3();
  heading = 0;
  private target = new THREE.Vector3();
  private waitLeft = 0;
  private speed: number;
  private phase: number;
  private mat: THREE.ShaderMaterial;
  private rnd: () => number;
  private nextBlink = 2;
  private blinkT = -1;
  private hopT = -1;
  private hopBase = 0;
  private look = 0;
  private curl = 0;
  private eyes = 1;
  private moving = 0;
  private koiAngle: number;
  /** 0..1 birth scale used by the hatch sequence. */
  birth = 1;
  moss: number;
  private zClock = 0;

  constructor(private shared: Shared, init: CreatureInit) {
    this.traits = deriveTraits(init.domain);
    this.state = init.state;
    this.wander = init.wander ?? true;
    this.rnd = stream(fnv1a(init.domain + ":life"));
    this.phase = this.rnd() * 10;
    this.speed = SPEED[this.traits.family] ?? 0.8;
    this.moss = mossFromAge(init.ageDays);
    this.koiAngle = this.rnd() * Math.PI * 2;
    this.mat = hatchMaterial(shared, { creature: true, look: { moss: this.moss } });
    this.mesh = new THREE.Mesh(geometryFor(this.traits), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.userData.creature = this;
    this.pos.set(init.x ?? 0, 0, init.z ?? 0);
    this.heading = init.heading ?? this.rnd() * 6;
    this.pickTarget();
    this.apply(true);
  }

  get uniforms() { return this.mat.uniforms; }

  setState(s: CreatureState) { this.state = s; }

  private pickTarget() {
    const a = this.rnd() * Math.PI * 2;
    const r = 4.3 + this.rnd() * 3.2;
    this.target.set(Math.cos(a) * r, 0, Math.sin(a) * r * 0.8);
    this.waitLeft = 0;
  }

  /** Send the creature toward a ground point (used when a demo creature walks into the trees). */
  goTo(x: number, z: number) { this.target.set(x, 0, z); this.waitLeft = 0; }

  hop() { if (this.hopT < 0) { this.hopT = 0; this.hopBase = this.pos.y; } }

  /** World position the overlay projects a tag onto. */
  tagPosition(out: THREE.Vector3) { return out.set(this.pos.x, this.mesh.position.y + 1.25 * this.traits.size, this.pos.z); }

  update(dt: number, t: number, calm: boolean, pointerWorld: THREE.Vector3 | null, emitZ?: (p: THREE.Vector3) => void, emitFlake?: (p: THREE.Vector3) => void) {
    const s = this.state;
    const sleeping = s === "sleeping";
    const drowsy = s === "drowsy";
    const slow = sleeping ? 0 : drowsy ? 0.45 : s === "traveling" ? 0.25 : 1;
    const isKoi = this.traits.family === "koi";
    const isMoth = this.traits.family === "moth";
    let moving = 0;

    if (this.wander && slow > 0 && this.birth >= 1) {
      if (isKoi) {
        this.koiAngle += dt * 0.32 * slow;
        const r = 1.3 + 0.7 * Math.sin(this.phase + t * 0.13);
        const nx = Math.cos(this.koiAngle) * r, nz = Math.sin(this.koiAngle) * r * 0.85;
        this.heading = Math.atan2(nx - this.pos.x, nz - this.pos.z);
        this.pos.set(nx, 0, nz);
        moving = 1;
      } else if (this.waitLeft > 0) {
        this.waitLeft -= dt;
      } else {
        const dx = this.target.x - this.pos.x, dz = this.target.z - this.pos.z;
        const d = Math.hypot(dx, dz);
        if (d < 0.15) { this.waitLeft = 1 + this.rnd() * 4; this.pickTarget(); this.waitLeft = 1 + this.rnd() * 3; }
        else {
          const want = Math.atan2(dx, dz);
          let da = want - this.heading;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          this.heading += da * Math.min(1, dt * 3);
          const v = this.speed * slow * Math.min(1, d);
          this.pos.x += Math.sin(this.heading) * v * dt;
          this.pos.z += Math.cos(this.heading) * v * dt;
          moving = Math.min(1, v / 0.6);
          // Keep out of the pool.
          const r = Math.hypot(this.pos.x, this.pos.z);
          if (!isMoth && r < POOL_R + 0.5) { this.pos.x *= (POOL_R + 0.5) / r; this.pos.z *= (POOL_R + 0.5) / r; this.pickTarget(); }
        }
      }
    }
    this.moving += (moving - this.moving) * Math.min(1, dt * 5);

    // Blink
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.blinkT < 0) { this.blinkT = 0; this.nextBlink = 2 + this.rnd() * 4; }
    let blink = 1;
    if (this.blinkT >= 0) { this.blinkT += dt; blink = Math.abs(this.blinkT - 0.07) / 0.07; if (this.blinkT > 0.14) this.blinkT = -1; blink = Math.min(1, Math.max(0.08, blink)); }
    const eyeTarget = sleeping ? 0.06 : drowsy ? 0.45 : 1;
    this.eyes += (eyeTarget - this.eyes) * Math.min(1, dt * 4);

    // Look toward the pointer (clamped), otherwise settle forward.
    let lookT = 0;
    if (pointerWorld && !sleeping) {
      const want = Math.atan2(pointerWorld.x - this.pos.x, pointerWorld.z - this.pos.z) - this.heading;
      const da = Math.atan2(Math.sin(want), Math.cos(want));
      if (Math.hypot(pointerWorld.x - this.pos.x, pointerWorld.z - this.pos.z) < 5) lookT = Math.max(-0.7, Math.min(0.7, da));
    }
    this.look += (lookT - this.look) * Math.min(1, dt * 4);

    this.curl += ((sleeping ? 1 : 0) - this.curl) * Math.min(1, dt * 3);

    // Hop
    let hopY = 0;
    if (this.hopT >= 0) {
      this.hopT += dt;
      const k = this.hopT / 0.5;
      hopY = Math.sin(Math.min(1, k) * Math.PI) * 0.4;
      if (k >= 1) this.hopT = -1;
    }

    const u = this.mat.uniforms;
    const breath = Math.sin((t + this.phase) * (sleeping ? 1.1 : 1.8));
    const ph = t + this.phase;
    const calmK = calm ? 0.5 : 1;
    u.uPose!.value.set(
      Math.sin(ph * 2.1 * slow) * 0.3 * (0.4 + slow) * calmK,
      this.look,
      Math.sin(ph * 0.7) * 0.08 + (this.hopT >= 0 ? 0.3 : 0),
      isMoth ? Math.sin(ph * (sleeping ? 2 : 20)) * (sleeping ? 0.1 : 0.75) + 0.15 : 0,
    );
    u.uPose2!.value.set(Math.sin(ph * 9) * 0.55 * this.moving, this.eyes * blink, breath, this.curl);
    u.uWave!.value = isKoi ? 0.09 * (0.4 + this.moving * 0.6) * (sleeping ? 0.2 : 1) : 0;

    // State look
    const blend = Math.min(1, dt * 4);
    const ease = (k: string, v: number) => { const un = u[k]!; un.value += (v - un.value) * blend; };
    ease("uSleep", sleeping ? 1 : drowsy ? 0.25 : 0);
    ease("uAttn", s === "attention" ? 1 : 0);
    ease("uShed", s === "shedding" ? 1 : 0);
    ease("uDesat", s === "traveling" ? 0.6 : 0);
    ease("uTint", s === "traveling" ? 1 : 0);
    u.uMoss!.value = this.moss;

    // Vertical placement
    let y = isKoi ? (sleeping ? -0.16 : -0.34) : isMoth ? 0.15 + Math.sin(ph * 1.6) * 0.07 : groundHeight(this.pos.x, this.pos.z);
    y += hopY;
    this.pos.y = y;
    this.apply(false);

    // Particles for states
    if (!calm) {
      this.zClock += dt;
      if ((sleeping || drowsy) && emitZ && this.zClock > (sleeping ? 1.4 : 2.6)) { this.zClock = 0; emitZ(_v.set(this.pos.x, y + 1.0 * this.traits.size, this.pos.z)); }
      if (s === "shedding" && emitFlake && this.rnd() < dt * 8) emitFlake(_v.set(this.pos.x + (this.rnd() - 0.5) * 0.4, y + 0.3 + this.rnd() * 0.5, this.pos.z + (this.rnd() - 0.5) * 0.4));
    }
  }

  private apply(_init: boolean) {
    const sc = this.birth * (1 + Math.max(0, this.birth - 1) * 0);
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.heading;
    this.mesh.scale.setScalar(Math.max(0.001, sc));
  }

  dispose() { this.mat.dispose(); }
}
