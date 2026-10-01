import * as THREE from "three";
import { liftChips, type ChipBox } from "./chipLayout";
import { deriveCreatureSpec, type CreatureSpec, type CreatureState, type Particle } from "@mosshatch/core";
import { makeShared, type Shared } from "./materials";
import { buildScenery, POOL_R, type Scenery } from "./scenery";
import { Bursts, Lanterns, makeAmbient, makeSky, Pool } from "./atmosphere";
import { CameraRig, type ViewName } from "./rig";
import { Adaptive, pickTier, type Tier } from "./quality";
import { Creature, getKit, type CreatureFx } from "./creatures/creature";

export { installKit, loadKit } from "./creatures/creature";
import { Decor } from "./creatures/decor";
import { Egg } from "./eggs";

export interface Spec { domain: string; available: boolean; /** A stored spec; derived from the name when absent. */ spec?: CreatureSpec }

export interface Hooks {
  /** Sound and flash hooks; the engine never touches audio or DOM directly. */
  onTick?(i: number): void;
  onFlash?(): void;
  onBorn?(spec: CreatureSpec): void;
  onLand?(): void;
  onDrop?(): void;
}

export interface Stats { calls: number; triangles: number; dpr: number; creatures: number }

const _v3 = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _col = new THREE.Color();

/** The imperative three.js world. React owns the overlay only. */
export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly shared: Shared = makeShared();
  readonly scene = new THREE.Scene();
  readonly rig = new CameraRig();
  readonly tier: Tier;
  private adaptive: Adaptive;
  private scenery: Scenery;
  private pool: Pool;
  private bursts = new Bursts();
  private lanterns: Lanterns;
  private ambient: THREE.Points;
  private decor: Decor;
  private eggs: Egg[] = [];
  private sleepers: Creature[] = [];
  private grove: Creature[] = [];
  private free: Creature[] = [];
  private raf = 0;
  private last = 0;
  private running = false;
  private clock = 0;
  calm = false;
  hooks: Hooks = {};
  /** DOM anchors for chips: id -> element. Positioned each frame by projection. */
  readonly overlay = new Map<string, HTMLElement>();
  overlayMode: "project" | "list" = "project";
  private pointerNdc = new THREE.Vector2(9, 9);
  private pointerWorld = new THREE.Vector3();
  private hasPointer = false;
  private ray = new THREE.Raycaster();
  private seq: Sequence | null = null;
  private lastPointerRipple = 0;
  private w = 1;
  private h = 1;
  /** Particle hooks handed to creatures. */
  readonly fx: CreatureFx = {
    z: (p) => this.bursts.emit(p, _v3b.set(0.12, 0.35, 0), Z_COL, 26, 2.4, 2, 0),
    flake: (p) => this.bursts.emit(p, _v3b.set((Math.random() - 0.5) * 0.3, 0.1, (Math.random() - 0.5) * 0.3), FLAKE_COL, 9, 1.4, 0, -0.1),
    burst: (kind, hue, p, count) => this.emitStyle(kind, hue, p, count),
  };

  constructor(readonly canvas: HTMLCanvasElement, opts: { calm: boolean; bare?: boolean }) {
    this.tier = pickTier();
    this.calm = opts.calm;
    this.rig.calm = opts.calm;
    this.shared.uCalm.value = opts.calm ? 1 : 0;
    this.adaptive = new Adaptive(this.tier.dprMax);
    const gl = canvas.getContext("webgl2", { antialias: this.tier.antialias, powerPreference: "high-performance", alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error("webgl2-unavailable");
    this.renderer = new THREE.WebGLRenderer({ canvas, context: gl });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x131a33, 1);
    this.renderer.autoClear = true;
    this.setDpr(this.adaptive.dpr);

    this.scenery = buildScenery(this.shared, { trees: opts.bare ? 0 : this.tier.trees, grass: this.tier.grass });
    this.pool = new Pool(this.shared);
    this.lanterns = new Lanterns(this.shared);
    this.ambient = makeAmbient(this.shared, this.tier.fireflies, this.tier.pollen);
    this.decor = new Decor(this.shared);
    this.scene.add(makeSky(this.shared), ...this.scenery.meshes, this.pool.mesh, this.decor.shells, this.decor.crates, this.decor.rings,
      this.lanterns.mesh, this.ambient, this.bursts.points);
    this.rig.setView("find");
    this.rig.snap();
  }

  private setDpr(d: number) {
    this.renderer.setPixelRatio(d);
    this.shared.uDpr.value = d;
    if (this.w > 1) this.renderer.setSize(this.w, this.h, false);
    this.updatePointScale();
  }

  /** Point sprite sizes are in world units: scale = drawing-buffer height / (2 tan(fov/2)). */
  private updatePointScale() {
    const px = this.h * this.renderer.getPixelRatio();
    const s = px / (2 * Math.tan((this.rig.camera.fov * Math.PI) / 360));
    const a = this.ambient?.material as THREE.ShaderMaterial | undefined;
    if (a) a.uniforms.uScale!.value = s;
    this.bursts?.setScale(s);
  }

  resize(w: number, h: number) {
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.rig.resize(w, h);
    this.setDpr(this.adaptive.dpr);
    this.updatePointScale();
  }

  setCalm(c: boolean) {
    this.calm = c; this.rig.calm = c; this.shared.uCalm.value = c ? 1 : 0;
    if (c) this.bursts.clear();
  }

  setView(v: ViewName, target?: THREE.Vector3, offset = 0, lift = 0) { this.rig.setView(v, target, offset, lift); }

  setPointer(clientX: number, clientY: number) {
    const r = this.canvas.getBoundingClientRect();
    this.pointerNdc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.rig.setPointer(this.pointerNdc.x, this.pointerNdc.y);
    this.hasPointer = true;
  }
  clearPointer() { this.hasPointer = false; this.rig.setPointer(0, 0); }

  /** Tap: returns the domain of a creature that was hit, after making it hop. */
  tap(clientX: number, clientY: number): Creature | null {
    const r = this.canvas.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1), this.rig.camera);
    const meshes = [...this.grove, ...this.sleepers, ...this.free].map((c) => c.mesh);
    const hit = this.ray.intersectObjects(meshes, false)[0];
    if (hit) { const c = hit.object.userData.creature as Creature; c.react(this.fx); return c; }
    return null;
  }

  ripple(x: number, z: number, s = 1) { this.pool.ripple(x, z, s); }

  /** Emit `count` particles in one of the spec's particle styles. */
  emitStyle(kind: Particle, hue: number, p: THREE.Vector3, count: number, spread = 1) {
    const kit = getKit();
    if (!kit || this.calm) return;
    const st = kit.PARTICLE_STYLE[kind];
    const color = _col.setHSL(hue / 360, 0.75, st.light);
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2, sp = Math.random() * st.speed * spread;
      this.bursts.emit(p, _v3b.set(Math.cos(a) * sp, st.up * (0.4 + Math.random() * 0.6) * spread, Math.sin(a) * sp), color, st.size * (0.7 + Math.random() * 0.6), st.life * (0.7 + Math.random() * 0.5), st.kind, st.gravity);
    }
  }
  /** A drop for each keystroke, near where the eggs will rise. */
  keystroke() {
    this.pool.ripple((Math.random() - 0.5) * 2.4, 0.4 + Math.random() * 1.2, 0.8);
  }

  /** Lay out results: available names as eggs on the water, taken names as sleepers on the far bank. */
  setResults(specs: Spec[]) {
    const now = this.clock;
    for (const e of this.eggs) { this.scene.remove(e.mesh); e.dispose(); }
    for (const s of this.sleepers) { this.scene.remove(s.mesh); s.dispose(); }
    this.eggs = []; this.sleepers = [];
    const avail = specs.filter((s) => s.available);
    const taken = specs.filter((s) => !s.available);
    avail.forEach((s, i) => {
      const e = new Egg(this.shared, s.domain, s.spec ?? deriveCreatureSpec(s.domain), i, avail.length, now);
      this.eggs.push(e); this.scene.add(e.mesh);
      setTimeout(() => this.pool.ripple(e.home.x, e.home.z, 1.1), 60 + i * 160);
      setTimeout(() => this.hooks.onDrop?.(), 60 + i * 160);
    });
    taken.forEach((s, i) => {
      const n = taken.length;
      const x = n === 1 ? 0 : -3.2 + (6.4 * i) / (n - 1);
      const spec = s.spec ?? deriveCreatureSpec(s.domain);
      const koi = spec.species === "koi";
      const z = koi ? -1.9 : -(POOL_R + 1.2) - Math.abs(x) * 0.04;
      const c = new Creature(this.shared, { id: s.domain, spec, state: "sleeping", ageDays: 900, x: koi ? Math.max(-1.6, Math.min(1.6, x * 0.5)) : x, z, heading: Math.PI + (Math.random() - 0.5) * 0.6, wander: false });
      this.sleepers.push(c); this.scene.add(c.mesh);
    });
  }

  clearResults() { this.setResults([]); }

  /** Position of the chip anchor for a result (egg top, or sleeper tag). `talk:<domain>` anchors the launcher's speech bubble. */
  private anchorFor(domain: string, out: THREE.Vector3): THREE.Vector3 | null {
    if (domain.startsWith("talk:")) { const c = this.creatureById(domain.slice(5)); return c ? c.tagPosition(out) : null; }
    const e = this.eggs.find((x) => x.domain === domain);
    if (e) return e.chipAnchor(out);
    const s = this.sleepers.find((x) => x.id === domain);
    if (s) return s.tagPosition(out);
    const g = [...this.grove, ...this.free].find((x) => x.id === domain);
    if (g) return g.tagPosition(out);
    return null;
  }

  /** Add a creature to the grove (session-local in Phase 1). */
  addToGrove(domain: string, state: CreatureState, ageDays: number, at?: { x: number; z: number }, spec?: CreatureSpec): Creature {
    const a = Math.random() * Math.PI * 2, r = 4.4 + Math.random() * 2.8;
    const c = new Creature(this.shared, { id: domain, spec: spec ?? deriveCreatureSpec(domain), state, ageDays, x: at?.x ?? Math.cos(a) * r, z: at?.z ?? Math.sin(a) * r * 0.8 });
    this.grove.push(c); this.scene.add(c.mesh);
    return c;
  }
  /** Take a finished hatch creature into the grove so it wanders. */
  adopt(c: Creature) { c.wander = true; c.birth = 1; c.birthTilt = 0; c.setAlpha(1); this.grove.push(c); }
  removeGrove(domain: string) {
    const i = this.grove.findIndex((c) => c.id === domain);
    if (i >= 0) { const [c] = this.grove.splice(i, 1); this.scene.remove(c!.mesh); c!.dispose(); }
  }
  clearGrove() { for (const c of this.grove) { this.scene.remove(c.mesh); c.dispose(); } this.grove = []; }
  groveCreatures() { return this.grove; }
  setGroveState(domain: string, s: CreatureState) { this.grove.find((c) => c.id === domain)?.setState(s); }
  /** Debug layout: an explicit grid of creatures, with no wandering. */
  layoutFixed(items: { domain: string; spec?: CreatureSpec; state: CreatureState; ageDays: number; x: number; z: number; heading?: number }[]) {
    this.clearGrove();
    for (const it of items) {
      const c = new Creature(this.shared, { id: it.domain, spec: it.spec ?? deriveCreatureSpec(it.domain), state: it.state, ageDays: it.ageDays, x: it.x, z: it.z, wander: false, heading: it.heading ?? 0 });
      this.grove.push(c); this.scene.add(c.mesh);
    }
  }

  // ---- the launcher (docs/LAUNCHER.md): the creature that talks ------------------------------------------------------------

  /** A creature in the scene by its id (the domain name). */
  creatureById(id: string): Creature | null {
    return this.grove.find((c) => c.id === id) ?? this.free.find((c) => c.id === id) ?? this.sleepers.find((c) => c.id === id) ?? null;
  }
  /** Speech amplitude 0..1 for the talking creature's glow (from streamed tokens today; from audio once voice exists). */
  setVoice(id: string, level: number) { const c = this.creatureById(id); if (c) c.voice = Math.max(0, Math.min(1, level)); }
  /** Frame the creature beside the conversation panel and keep it still while it talks. */
  focusCreature(id: string, offset = 0, lift = 0): boolean {
    const c = this.creatureById(id);
    if (!c) return false;
    c.listening = true;
    this.setView("detail", _v3.set(c.pos.x, c.pos.y, c.pos.z), offset, lift);
    return true;
  }
  releaseCreature(id: string) { const c = this.creatureById(id); if (c) { c.listening = false; c.voice = 0; } }
  /**
   * Gold sparks when the brief is ready: a rising spiral of gold motes and shards around the creature, plus its own particle style.
   * Calm mode: no particles and no motion; the creature's glow swells once and fades instead.
   */
  goldSparks(id: string) {
    const c = this.creatureById(id);
    if (!c) return;
    c.swell();
    if (this.calm) return;
    const base = _v3.set(c.pos.x, c.pos.y + c.height * 0.55, c.pos.z);
    // A bright bloom at the heart, then three turns of a rising spiral of soft gold motes that drift up and fade.
    for (let i = 0; i < 6; i++) this.bursts.emit(base, _vel.set((Math.random() - 0.5) * 0.3, 0.25 + Math.random() * 0.3, (Math.random() - 0.5) * 0.3), GOLD_HI, 26 + Math.random() * 12, 0.7 + Math.random() * 0.3, 0, 0);
    for (let i = 0; i < 72; i++) {
      const k = i / 72, a = k * Math.PI * 6 + Math.random() * 0.4, r = 0.3 + k * 0.6;
      this.bursts.emit(_v3b.set(base.x + Math.cos(a) * r, base.y - 0.2 + k * 0.5, base.z + Math.sin(a) * r),
        _vel.set(Math.cos(a + 1.6) * 0.45, 0.7 + Math.random() * 1.0, Math.sin(a + 1.6) * 0.45), i % 4 === 0 ? GOLD_HI : GOLD, 9 + Math.random() * 10, 1.4 + Math.random() * 1.0, 0, -0.2);
    }
    this.emitStyle(c.spec.choreography.hatch.particles.kind, 44, base, 12, 0.8);
  }

  /** The signature moment. Resolves with the creature once it lands on the bank. */
  hatch(domain: string, opts: { demo?: boolean } = {}): Promise<Creature> {
    const egg = this.eggs.find((e) => e.domain === domain);
    if (!egg) return Promise.reject(new Error("no egg for " + domain));
    return new Promise((resolve) => {
      this.seq = new Sequence(this, egg, domain, opts.demo ?? false, resolve);
    });
  }

  /** Abort a hatch in progress (demo cancelled by input): remove the newborn and put the eggs back. */
  cancelHatch() {
    if (!this.seq) return;
    this.seq.abort();
    this.seq = null;
    for (const e of this.eggs) { e.visible = true; e.sink = 0; e.wobble = 0; e.glow = e.baseGlow; e.crack = 0; e.alpha = 1; }
    this.setView("find");
  }

  /** Render one card image of a creature with a portrait camera into a render target. */
  snapshot(c: Creature, w = 512, h = 640): string {
    const rt = new THREE.WebGLRenderTarget(w, h, { samples: 0 });
    const cam = new THREE.PerspectiveCamera(30, w / h, 0.1, 100);
    const p = c.pos, sz = c.spec.size;
    cam.position.set(p.x + 0.55 * sz, p.y + 0.85 * sz, p.z + 2.9 * sz);
    cam.lookAt(p.x, p.y + 0.55 * sz, p.z);
    const prev = this.renderer.getRenderTarget();
    const pr = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(1);
    this.shared.uDpr.value = 1;
    this.renderer.setRenderTarget(rt);
    this.renderer.render(this.scene, cam);
    const buf = new Uint8Array(w * h * 4);
    this.renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
    this.renderer.setRenderTarget(prev);
    this.renderer.setPixelRatio(pr);
    this.shared.uDpr.value = pr;
    rt.dispose();
    const cv = document.createElement("canvas");
    cv.width = w; cv.height = h;
    const ctx = cv.getContext("2d")!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(buf.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    return cv.toDataURL("image/png");
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.last = performance.now();
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      const ms = now - this.last; this.last = now;
      const dt = Math.min(0.05, ms / 1000);
      this.frame(dt, ms);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop() { this.running = false; cancelAnimationFrame(this.raf); }

  /** Advance and draw one frame. */
  frame(dt: number, ms = dt * 1000) {
    this.update(dt);
    this.draw(ms);
  }

  /** Advance the simulation without drawing; tests use this to step time deterministically. */
  update(dt: number) {
    this.clock += dt;
    const t = this.clock;
    this.shared.uTime.value = t;
    this.lanterns.update(this.shared, t, this.calm);

    // Pointer on the ground plane, for looking and pool ripples.
    let pw: THREE.Vector3 | null = null;
    if (this.hasPointer) {
      this.ray.setFromCamera(this.pointerNdc, this.rig.camera);
      const o = this.ray.ray.origin, d = this.ray.ray.direction;
      if (d.y < -0.001) {
        const k = -o.y / d.y;
        this.pointerWorld.set(o.x + d.x * k, 0, o.z + d.z * k);
        pw = this.pointerWorld;
        if (!this.calm && Math.hypot(pw.x, pw.z) < POOL_R - 0.2 && t - this.lastPointerRipple > 0.28) {
          this.lastPointerRipple = t; this.pool.ripple(pw.x, pw.z, 0.35);
        }
      }
    }

    const all = [...this.grove, ...this.sleepers, ...this.free];
    for (const c of all) if (!(this.seq && this.seq.owns(c))) c.update(dt, t, this.calm, pw, this.fx);
    for (const e of this.eggs) e.update(t, this.calm);
    this.decor.update(all, t);
    if (this.seq) { if (this.seq.update(dt, t)) this.seq = null; }
    this.bursts.update(dt);
    this.rig.update(dt, t);
  }

  private draw(ms: number) {
    this.renderer.render(this.scene, this.rig.camera);
    this.projectOverlay();

    const nd = this.adaptive.frame(ms);
    if (nd !== null) this.setDpr(nd);
  }

  private projectOverlay() {
    if (this.overlayMode !== "project") return;
    const cam = this.rig.camera;
    // Read every chip's place and size first, then write: chips that would overlap are lifted apart (chipLayout).
    const items: { el: HTMLElement; x: number; y: number; z: number }[] = [], boxes: ChipBox[] = [];
    for (const [id, el] of this.overlay) {
      const a = this.anchorFor(id, _v3);
      if (!a) continue;
      a.project(cam);
      const x = (a.x * 0.5 + 0.5) * this.w, y = (-a.y * 0.5 + 0.5) * this.h;
      items.push({ el, x, y, z: a.z });
      boxes.push({ x, y, w: el.offsetWidth, h: el.offsetHeight, row: el.dataset.row ? +el.dataset.row : 0 });
    }
    const lifts = liftChips(boxes);
    items.forEach(({ el, x, y, z }, i) => {
      el.style.transform = `translate3d(${x.toFixed(1)}px, ${(y - lifts[i]!).toFixed(1)}px, 0) translate(-50%, -100%)`;
      el.style.opacity = z < 1 ? "" : "0";
    });
  }

  stats(): Stats {
    const i = this.renderer.info;
    return { calls: i.render.calls, triangles: i.render.triangles, dpr: this.renderer.getPixelRatio(), creatures: this.grove.length + this.sleepers.length + this.free.length };
  }

  // Internals used by Sequence
  get _bursts() { return this.bursts; }
  get _pool() { return this.pool; }
  get _scene() { return this.scene; }
  get _eggs() { return this.eggs; }
  get _grove() { return this.grove; }

  dispose() {
    this.stop();
    this.scenery.dispose();
    this.renderer.dispose();
  }
}

const Z_COL = new THREE.Color("#8fa3c8");
const GOLD = new THREE.Color("#ffc65c");
const GOLD_HI = new THREE.Color("#fff1b8");
const _vel = new THREE.Vector3();
const FLAKE_COL = new THREE.Color("#3a9a98");

/**
 * The Hatch, driven by the spec's choreography: wobble while the shell cracks in its pattern, burst in its particle style, the
 * emergence move, then a hop (or glide) to the bank. In calm mode the motion is replaced by fades: no wobble, shake, burst or hop.
 */
class Sequence {
  private t = 0;
  private creature: Creature;
  private ticks: number[];
  private tickI = 0;
  private burst = false;
  private landed = false;
  private beam: THREE.Mesh | null = null;
  private from = new THREE.Vector3();
  private to = new THREE.Vector3();
  private hopStart = -1;
  private done = false;
  private pre: number;
  private em: number;
  private calm: boolean;
  private spec: CreatureSpec;
  private landedAt: number | undefined;

  constructor(private w: World, private egg: Egg, domain: string, private demo: boolean, private resolve: (c: Creature) => void) {
    this.spec = egg.spec;
    const D = this.spec.choreography.hatch.duration;
    this.pre = D * 0.68;
    this.em = D - this.pre;
    this.ticks = [0.37, 0.62, 0.81, 0.92].map((f) => f * this.pre);
    this.calm = w.calm;
    this.creature = new Creature(w.shared, { id: domain, spec: this.spec, state: "thriving", ageDays: 0, x: egg.home.x, z: egg.home.z, wander: false });
    this.creature.birth = 0;
    this.creature.mesh.visible = false;
    w._scene.add(this.creature.mesh);
    w.setView("hatch", _v3.set(egg.home.x, 0.4, egg.home.z));
    for (const e of w._eggs) if (e !== egg) e.visible = true;
    const a = Math.atan2(egg.home.x, 1.2);
    this.to.set(Math.sin(a) * (POOL_R + 0.9) + egg.home.x * 0.2, 0, POOL_R + 0.9);
    if (this.calm) return;
    const bm = new THREE.ShaderMaterial({
      uniforms: { uA: { value: 0 } },
      vertexShader: `varying float vY; varying vec3 vN; varying vec3 vV; void main(){ vY = position.y; vN = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position,1.0); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: `precision mediump float; varying float vY; varying vec3 vN; varying vec3 vV; uniform float uA; void main(){ float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.6); float a = uA * (1.0 - clamp(vY/6.0,0.0,1.0)) * 0.55 * edge; gl_FragColor = vec4(vec3(1.0,0.82,0.5)*a, a); }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    this.beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.9, 6, 20, 1, true).translate(0, 3, 0), bm);
    this.beam.position.set(egg.home.x, 0, egg.home.z);
    this.beam.visible = false; this.beam.frustumCulled = false; this.beam.renderOrder = 8;
    w._scene.add(this.beam);
  }

  abort() {
    this.w._scene.remove(this.creature.mesh);
    this.creature.dispose();
    if (this.beam) this.w._scene.remove(this.beam);
    this.egg.alpha = 1; this.egg.crack = 0;
    this.done = true;
  }

  owns(c: Creature) { return c === this.creature && !this.landed; }

  update(dt: number, now: number): boolean {
    this.t += dt;
    const t = this.t, w = this.w, egg = this.egg, c = this.creature, calm = this.calm;
    const ch = this.spec.choreography.hatch;
    // Other eggs sink quietly.
    for (const e of w._eggs) if (e !== egg) e.sink = Math.min(1, e.sink + dt * 0.8);
    if (t < this.pre) {
      const k = t / this.pre;
      egg.wobble = calm ? 0 : k * k;
      egg.glow = egg.baseGlow + k * 0.9;
      egg.crack = Math.min(1, k * 1.1);
      while (this.tickI < this.ticks.length && t >= this.ticks[this.tickI]!) {
        w.hooks.onTick?.(this.tickI);
        if (!calm) {
          w.rig.shake(0.25 + this.tickI * 0.15);
          w.emitStyle(ch.particles.kind, ch.particles.hue, _v3.set(egg.home.x, 0.4, egg.home.z), 4, 0.5);
        }
        this.tickI++;
      }
    } else if (!this.burst) {
      this.burst = true;
      w.hooks.onFlash?.();
      c.mesh.visible = true;
      c.heading = Math.PI * 0.1;
      if (calm) {
        c.birth = 1;
        c.pos.copy(this.to);
        c.heading = 0.25;
        c.setAlpha(0);
      } else {
        egg.visible = false;
        w.rig.shake(1.4);
        w._pool.ripple(egg.home.x, egg.home.z, 2.6);
        w._pool.ripple(egg.home.x, egg.home.z, 1.4);
        const p = _v3.set(egg.home.x, 0.45, egg.home.z);
        const shell = _col.setHSL(ch.shell.base.h / 360, ch.shell.base.s, ch.shell.base.l);
        for (let i = 0; i < 20; i++) {
          const a = Math.random() * Math.PI * 2, sp = 1.2 + Math.random() * 2.2;
          w._bursts.emit(p, _v3b.set(Math.cos(a) * sp, 1.4 + Math.random() * 2.2, Math.sin(a) * sp), shell, 9 + Math.random() * 6, 1.1, 1, 6);
        }
        w.emitStyle(ch.particles.kind, ch.particles.hue, p, 30);
        if (this.beam) this.beam.visible = true;
        c.birth = 0.001;
        c.pos.set(egg.home.x, 0.1, egg.home.z);
      }
      c.mesh.position.copy(c.pos);
      w.hooks.onBorn?.(this.spec);
    }
    if (this.burst) {
      const bt = t - this.pre;
      if (calm) {
        egg.alpha = Math.max(0, 1 - bt / 0.6);
        c.setAlpha(Math.min(1, bt / Math.max(0.8, this.em)));
        if (!this.landed && bt >= Math.max(0.8, this.em)) {
          this.landed = true;
          c.setAlpha(1);
          egg.visible = false; egg.alpha = 1;
          w.hooks.onLand?.();
          w.rig.setView("detail", _v3.set(c.pos.x, c.pos.y, c.pos.z), 0);
        }
      } else {
        if (this.beam) { (this.beam.material as THREE.ShaderMaterial).uniforms.uA!.value = Math.max(0, 1 - bt / 1.4); if (bt > 1.4) this.beam.visible = false; }
        if (bt < this.em) {
          const e = getKit()!.emergePose(ch.emerge, bt / this.em);
          c.birth = Math.max(0.001, e.scale);
          c.birthTilt = e.tilt;
          c.pos.set(egg.home.x, e.y, egg.home.z);
        } else if (!this.landed) {
          if (this.hopStart < 0) {
            this.from.set(egg.home.x, c.pos.y, egg.home.z);
            this.hopStart = bt;
            c.heading = Math.atan2(this.to.x - this.from.x, this.to.z - this.from.z);
            c.birthTilt = 0;
          }
          const glide = c.locomotion === "fly" || this.spec.species === "spiritfox";
          const hk = Math.min(1, (bt - this.hopStart) / 0.95);
          c.pos.x = this.from.x + (this.to.x - this.from.x) * hk;
          c.pos.z = this.from.z + (this.to.z - this.from.z) * hk;
          c.pos.y = this.from.y * (1 - hk) + Math.sin(hk * Math.PI) * (glide ? 0.6 : 1.1);
          c.birth = 1;
          if (hk >= 1) {
            this.landed = true;
            c.pos.y = 0;
            w.hooks.onLand?.();
            w.rig.shake(0.5);
            w.emitStyle("dust", 40, _v3.set(c.pos.x, 0.05, c.pos.z), 10, 0.6);
            c.heading = 0.25; // face the camera
            w.rig.setView("detail", _v3.set(c.pos.x, c.pos.y, c.pos.z), 0);
          }
        }
      }
      c.mesh.position.copy(c.pos);
      c.mesh.rotation.y = c.heading;
      c.mesh.scale.setScalar(Math.max(0.001, c.birth));
      c.uniforms.uPose2!.value.set(0, 1, Math.sin(now * 2), 0);
      c.uniforms.uPose3!.value.set(0, 0, c.birthTilt, 0);
      if (this.landed && !this.done) {
        this.landedAt ??= t;
        if (t - this.landedAt > 0.9) {
          this.done = true;
          // Hand the creature over: it is now a free creature the caller may keep or remove.
          if (this.beam) { this.w._scene.remove(this.beam); }
          this.resolve(c);
          return true;
        }
      }
    }
    void this.demo;
    return false;
  }
}
