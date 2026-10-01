import * as THREE from "three";
import { fnv1a, mossFromAge, sanitizeSpec, specKey, SPECIES_INFO, stream, type CreatureSpec, type CreatureState, type Idle, type Particle, type Reaction } from "@mosshatch/core";
import { hatchMaterial, type Shared } from "../materials";
import { groundHeight, POOL_R } from "../scenery";
import type * as KitModule from "./kit";
import type { Move, Pose } from "./moves";

export type Kit = typeof KitModule;

/** The creature kit (builders and motion library) is its own lazy chunk; the host loads it next to the engine. */
let kit: Kit | null = null;
let kitPromise: Promise<Kit> | null = null;
const waiting = new Set<Creature>();
export function installKit(k: Kit) {
  kit = k;
  for (const c of waiting) c.attach();
  waiting.clear();
}
export function loadKit(): Promise<Kit> {
  if (kit) return Promise.resolve(kit);
  return (kitPromise ??= import("./kit").then((k) => { installKit(k); return k; }));
}
export function getKit(): Kit | null { return kit; }

interface Built { geometry: THREE.BufferGeometry; headPivot: THREE.Vector3; height: number }
const cache = new Map<string, Built>();
function built(spec: CreatureSpec): Built {
  // Geometry depends on looks only; motion and text are left out of the key.
  const key = specKey({ ...spec, speciesName: "", bio: "", choreography: { ...spec.choreography, idle: [], react: "hop", pitch: 1 } });
  let g = cache.get(key);
  if (!g) { g = kit!.buildCreature(spec); cache.set(key, g); }
  return g;
}
const EMPTY = new THREE.BufferGeometry();

const SPEED: Record<string, number> = { fox: 0.9, hare: 1.0, beetle: 0.55, hedgehog: 0.5, owl: 0.5, koi: 0.6, moth: 1.1, salamander: 0.6, spiritfox: 0.8 };
const MOONRIM = new THREE.Color(0.55, 0.66, 1.0);
const TALK_RIM = new THREE.Color(1.0, 0.78, 0.42);
const _v = new THREE.Vector3();
const _c = new THREE.Color();

export interface CreatureInit {
  /** The id the world finds this creature by (the domain name); never used for looks. */
  id: string;
  spec: CreatureSpec;
  state: CreatureState;
  ageDays: number;
  x?: number; z?: number; heading?: number;
  wander?: boolean;
}

export interface CreatureFx {
  z?(p: THREE.Vector3): void;
  flake?(p: THREE.Vector3): void;
  /** A small burst in the named particle style and hue. */
  burst?(kind: Particle, hue: number, p: THREE.Vector3, count: number): void;
}

export class Creature {
  readonly id: string;
  readonly spec: CreatureSpec;
  readonly mesh: THREE.Mesh;
  state: CreatureState;
  wander: boolean;
  /** Position on the ground plane; y is derived. */
  pos = new THREE.Vector3();
  heading = 0;
  /** Tag height above the feet. */
  height = 1;
  private target = new THREE.Vector3();
  private waitLeft = 0;
  private speed: number;
  private phase: number;
  private mat: THREE.ShaderMaterial;
  private rnd: () => number;
  private nextBlink = 2;
  private blinkT = -1;
  private look = 0;
  private curl = 0;
  private eyes = 1;
  private moving = 0;
  private koiAngle: number;
  private action: { move: Move; t: number; kind: Idle | Reaction } | null = null;
  private nextIdle: number;
  private pose!: Pose;
  private moteClock = 0;
  /** 0..1 birth scale used by the hatch sequence. */
  birth = 1;
  /** Extra tilt and height offset used by the hatch sequence. */
  birthTilt = 0;
  moss: number;
  private zClock = 0;
  /** The launcher: speech amplitude 0..1 set by the page while the creature talks (drives its glow). */
  voice = 0;
  private voiceS = 0;
  private swellT = -1;
  private baseGlow = 0;
  private baseRim = 0;
  /** While the owner talks to it, the creature stays where it is and faces the camera. */
  listening = false;
  readonly locomotion: "walk" | "fly" | "swim";

  constructor(private shared: Shared, init: CreatureInit) {
    this.id = init.id;
    this.spec = sanitizeSpec(init.spec);
    this.state = init.state;
    this.wander = init.wander ?? true;
    this.rnd = stream(fnv1a(init.id + ":life"));
    this.phase = this.rnd() * 10;
    this.speed = SPEED[this.spec.species] ?? 0.8;
    this.locomotion = SPECIES_INFO[this.spec.species].locomotion;
    this.moss = mossFromAge(init.ageDays);
    this.koiAngle = this.rnd() * Math.PI * 2;
    this.nextIdle = 1 + this.rnd() * 3;
    this.mat = hatchMaterial(shared, { creature: true, look: { moss: this.moss } });
    const u = this.mat.uniforms;
    const e = this.spec.effect;
    if (e === "moonrim") { u.uRimCol!.value.copy(MOONRIM); u.uRimK!.value = 0.32; }
    if (e === "iridescent") { u.uIri!.value = 1; u.uRimCol!.value.copy(_c.setHSL(this.spec.accent.h / 360, 0.7, 0.6)); u.uRimK!.value = 0.15; }
    if (e === "glow") { u.uRimCol!.value.copy(_c.setHSL(this.spec.accent.h / 360, 0.8, 0.7)); u.uRimK!.value = 0.55; u.uGlow!.value = 0.04; }
    // A creature with no rim of its own gets a lantern-gold rim at strength 0, so speaking can brighten it.
    if (e === "none") u.uRimCol!.value.copy(TALK_RIM);
    this.baseGlow = u.uGlow!.value as number;
    this.baseRim = u.uRimK!.value as number;
    this.mesh = new THREE.Mesh(EMPTY, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.userData.creature = this;
    this.pos.set(init.x ?? 0, 0, init.z ?? 0);
    this.heading = init.heading ?? this.rnd() * 6;
    if (kit) this.attach(); else { waiting.add(this); void loadKit(); }
    this.pickTarget();
    this.apply();
  }

  /** Swap in the real geometry once the kit is here. */
  attach() {
    const b = built(this.spec);
    this.mesh.geometry = b.geometry;
    this.height = b.height;
    this.mat.uniforms.uHeadPivot!.value.copy(b.headPivot);
    this.pose = kit!.newPose();
  }

  get uniforms() { return this.mat.uniforms; }
  /** Fade the whole creature (used instead of motion in calm mode). */
  setAlpha(a: number) {
    const f = a < 0.999;
    if (this.mat.transparent !== f) { this.mat.transparent = f; this.mat.depthWrite = !f; this.mat.needsUpdate = true; }
    this.mat.uniforms.uAlpha!.value = a;
  }
  get material() { return this.mat; }
  /** Kept for older callers: the size factor from the spec. */
  get size() { return this.spec.size; }

  setState(s: CreatureState) { this.state = s; }

  private pickTarget() {
    const a = this.rnd() * Math.PI * 2;
    const r = 4.3 + this.rnd() * 3.2;
    this.target.set(Math.cos(a) * r, 0, Math.sin(a) * r * 0.8);
    this.waitLeft = 0;
  }

  /** Send the creature toward a ground point (used when a demo creature walks into the trees). */
  goTo(x: number, z: number) { this.target.set(x, 0, z); this.waitLeft = 0; }

  /** The reaction to a tap, from the spec. */
  react(fx?: CreatureFx) {
    if (!kit) return;
    const kind = this.spec.choreography.react;
    const move = kit.REACTIONS[kind];
    this.action = { move, t: 0, kind };
    if (move.burst && fx?.burst) fx.burst(move.burst, this.spec.accent.h, _v.set(this.pos.x, this.pos.y + this.height * 0.6, this.pos.z), 10);
  }
  /** Older name for a tap reaction. */
  hop() { this.react(); }

  /** One slow swell of light (the brief is ready; also calm mode's stand-in for gold sparks). */
  swell() { this.swellT = 0; }

  /** World position the overlay projects a tag onto. */
  tagPosition(out: THREE.Vector3) { return out.set(this.pos.x, this.mesh.position.y + this.height + 0.1, this.pos.z); }

  update(dt: number, t: number, calm: boolean, pointerWorld: THREE.Vector3 | null, fx: CreatureFx = {}) {
    if (!kit) return;
    const s = this.state;
    const sleeping = s === "sleeping";
    const drowsy = s === "drowsy";
    const slow = sleeping ? 0 : drowsy ? 0.45 : s === "traveling" ? 0.25 : 1;
    const isKoi = this.locomotion === "swim";
    const flies = this.locomotion === "fly";
    let moving = 0;

    if (this.listening) { let da = 0.25 - this.heading; da = Math.atan2(Math.sin(da), Math.cos(da)); this.heading += da * Math.min(1, dt * 3); }
    if (this.wander && !this.listening && slow > 0 && this.birth >= 1) {
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
        if (d < 0.15) { this.pickTarget(); this.waitLeft = 1 + this.rnd() * 3; }
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
          if (!flies && r < POOL_R + 0.5) { this.pos.x *= (POOL_R + 0.5) / r; this.pos.z *= (POOL_R + 0.5) / r; this.pickTarget(); }
        }
      }
    }
    this.moving += (moving - this.moving) * Math.min(1, dt * 5);

    // Idle moves from the spec, while standing still and awake.
    const p = kit.zeroPose(this.pose);
    if (!this.action && !sleeping && this.birth >= 1 && this.moving < 0.2) {
      this.nextIdle -= dt;
      if (this.nextIdle <= 0) {
        const kind = kit.pickIdle(this.spec.choreography.idle, this.rnd());
        this.action = { move: kit.IDLE_MOVES[kind], t: 0, kind };
        this.nextIdle = 2.5 + this.rnd() * 4;
      }
    }
    if (this.action) {
      this.action.t += dt;
      const k = this.action.t / this.action.move.dur;
      if (k >= 1) this.action = null;
      else this.action.move.run(p, k, t);
    }
    if (calm) { p.lift = 0; p.spin = 0; p.squash *= 0.3; p.tail *= 0.4; p.wing *= 0.4; p.yaw *= 0.6; p.pitch *= 0.6; }

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

    // Hares hop as they go.
    const gait = this.spec.species === "hare" && !calm ? Math.abs(Math.sin(t * 7)) * 0.1 * this.moving : 0;

    const u = this.mat.uniforms;
    const breath = Math.sin((t + this.phase) * (sleeping ? 1.1 : 1.8));
    const ph = t + this.phase;
    const calmK = calm ? 0.5 : 1;
    const wingIdle = flies ? Math.sin(ph * (sleeping ? 2 : 20)) * (sleeping ? 0.1 : 0.75) * calmK + 0.15 : 0;
    u.uPose!.value.set(
      Math.sin(ph * 2.1 * slow) * 0.3 * (0.4 + slow) * calmK + p.tail,
      this.look + p.yaw,
      Math.sin(ph * 0.7) * 0.08 + p.ear,
      wingIdle + p.wing,
    );
    u.uPose2!.value.set(Math.sin(ph * 9) * 0.55 * this.moving, this.eyes * blink * p.eyes, breath, Math.max(this.curl, p.curl));
    u.uPose3!.value.set(p.pitch, p.squash, p.tilt + this.birthTilt, p.lift + gait);
    const waves = isKoi || this.spec.species === "salamander";
    u.uWave!.value = waves ? (isKoi ? 0.09 * (0.4 + this.moving * 0.6) : 0.06 * this.moving) * (sleeping ? 0.2 : 1) + p.wave : p.wave;

    // State look
    const blend = Math.min(1, dt * 4);
    const ease = (k: string, v: number) => { const un = u[k]!; un.value += (v - un.value) * blend; };
    ease("uSleep", sleeping ? 1 : drowsy ? 0.25 : 0);
    ease("uAttn", s === "attention" ? 1 : 0);
    ease("uShed", s === "shedding" ? 1 : 0);
    ease("uDesat", s === "traveling" ? 0.6 : 0);
    ease("uTint", s === "traveling" ? 1 : 0);
    u.uMoss!.value = this.moss;
    // Speaking glow: follows each streamed word, or in calm mode fades in while it talks and out after, with no pulsing.
    const target = calm ? (this.voice > 0.02 ? 0.4 : 0) : this.voice;
    this.voiceS += (target - this.voiceS) * Math.min(1, dt * (calm ? 1.2 : 16));
    let swell = 0;
    if (this.swellT >= 0) { this.swellT += dt; const d = calm ? 2.4 : 1.6; swell = Math.sin(Math.min(1, this.swellT / d) * Math.PI); if (this.swellT > d) this.swellT = -1; }
    u.uGlow!.value = this.baseGlow + this.voiceS * 0.3 + swell * 0.2;
    u.uRimK!.value = this.baseRim + this.voiceS * 0.75 + swell * 0.5;

    // Vertical placement
    const hover = this.spec.species === "spiritfox" && !sleeping ? 0.08 + Math.sin(ph * 1.3) * 0.04 * calmK : 0;
    const y = isKoi ? (sleeping ? -0.16 : -0.34) : flies ? 0.15 + Math.sin(ph * 1.6) * 0.07 * calmK : groundHeight(this.pos.x, this.pos.z) + hover;
    this.pos.y = y;
    this.apply(p.spin);

    // Particles for states and the legendary glow.
    if (!calm) {
      this.zClock += dt;
      if ((sleeping || drowsy) && fx.z && this.zClock > (sleeping ? 1.4 : 2.6)) { this.zClock = 0; fx.z(_v.set(this.pos.x, y + this.height * 0.8, this.pos.z)); }
      if (s === "shedding" && fx.flake && this.rnd() < dt * 8) fx.flake(_v.set(this.pos.x + (this.rnd() - 0.5) * 0.4, y + 0.3 + this.rnd() * 0.5, this.pos.z + (this.rnd() - 0.5) * 0.4));
      if (this.spec.effect === "glow" && fx.burst && !sleeping) {
        this.moteClock += dt;
        if (this.moteClock > 0.7) { this.moteClock = 0; fx.burst("motes", this.spec.accent.h, _v.set(this.pos.x + (this.rnd() - 0.5) * 0.5, y + this.height * (0.3 + this.rnd() * 0.5), this.pos.z + (this.rnd() - 0.5) * 0.5), 1); }
      }
    }
  }

  private apply(spin = 0) {
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.heading + spin;
    this.mesh.scale.setScalar(Math.max(0.001, this.birth));
  }

  dispose() { waiting.delete(this); this.mat.dispose(); }
}
