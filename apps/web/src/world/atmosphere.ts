import * as THREE from "three";
import common from "./shaders/common.glsl?raw";
import skyV from "./shaders/sky.vert?raw";
import skyF from "./shaders/sky.frag?raw";
import poolV from "./shaders/pool.vert?raw";
import poolF from "./shaders/pool.frag?raw";
import pointsV from "./shaders/points.vert?raw";
import pointsF from "./shaders/points.frag?raw";
import burstV from "./shaders/burst.vert?raw";
import burstF from "./shaders/burst.frag?raw";
import haloF from "./shaders/halo.frag?raw";
import { fnv1a, stream } from "@mosshatch/core";
import type { Shared } from "./materials";
import { LANTERNS, POOL_R } from "./scenery";

export function makeSky(shared: Shared): THREE.Mesh {
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uSkyTop: shared.uSkyTop, uSkyHor: shared.uSkyHor, uMoonDir: shared.uMoonDir, uFogCol: shared.uFogCol },
    vertexShader: skyV, fragmentShader: common + skyF, side: THREE.BackSide, depthWrite: false, depthTest: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(50, 32, 16), m);
  mesh.frustumCulled = false;
  mesh.renderOrder = -10;
  return mesh;
}

export class Pool {
  mesh: THREE.Mesh;
  private rip = Array.from({ length: 8 }, () => new THREE.Vector4(0, 0, -100, 0));
  private next = 0;
  constructor(private shared: Shared) {
    const m = new THREE.ShaderMaterial({
      uniforms: {
        uTime: shared.uTime, uRip: { value: this.rip }, uSkyTop: shared.uSkyTop, uSkyHor: shared.uSkyHor, uMoonDir: shared.uMoonDir,
        uLP: shared.uLP, uLCol: shared.uLCol, uFogCol: shared.uFogCol, uFogNear: shared.uFogNear, uFogFar: shared.uFogFar,
        uRadius: { value: POOL_R },
      },
      vertexShader: poolV, fragmentShader: common + poolF, transparent: true, depthWrite: false,
    });
    this.mesh = new THREE.Mesh(new THREE.CircleGeometry(POOL_R + 0.02, 64).rotateX(-Math.PI / 2), m);
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
  }
  /** Up to eight concurrent ripples: keystrokes, eggs surfacing, the hatch, the pointer. */
  ripple(x: number, z: number, strength = 1) {
    this.rip[this.next]!.set(x, z, this.shared.uTime.value, strength);
    this.next = (this.next + 1) % 8;
  }
}

/** Fireflies (kind 0) and pollen (kind 1) as additive point sprites in one draw call. */
export function makeAmbient(shared: Shared, fireflies: number, pollen: number): THREE.Points {
  const rnd = stream(fnv1a("ambient"));
  const n = fireflies + pollen;
  const pos = new Float32Array(n * 3), seed = new Float32Array(n * 4), kind = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = rnd() * Math.PI * 2, r = 2 + rnd() * 13;
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = 0.4 + rnd() * 3.2; pos[i * 3 + 2] = Math.sin(a) * r * 0.9 - 1;
    for (let k = 0; k < 4; k++) seed[i * 4 + k] = rnd();
    kind[i] = i < fireflies ? 0 : 1;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
  g.setAttribute("aSeed", new THREE.BufferAttribute(seed, 4));
  g.setAttribute("aKind", new THREE.BufferAttribute(kind, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { uTime: shared.uTime, uScale: { value: 300 }, uCalm: shared.uCalm },
    vertexShader: pointsV, fragmentShader: pointsF, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 8;
  return pts;
}

/** CPU-driven particle pool for sparks, shards, dust, flakes and sleep z's. One draw call. */
export class Bursts {
  points: THREE.Points;
  private N = 256;
  private pos = new Float32Array(this.N * 3);
  private vel = new Float32Array(this.N * 3);
  private data = new Float32Array(this.N * 4);
  private col = new Float32Array(this.N * 3);
  private life = new Float32Array(this.N);
  private decay = new Float32Array(this.N);
  private grav = new Float32Array(this.N);
  private next = 0;
  private g = new THREE.BufferGeometry();
  private uScale: { value: number };
  constructor() {
    this.g.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.g.setAttribute("aData", new THREE.BufferAttribute(this.data, 4).setUsage(THREE.DynamicDrawUsage));
    this.g.setAttribute("aCol", new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.uScale = { value: 300 };
    const m = new THREE.ShaderMaterial({
      uniforms: { uScale: this.uScale }, vertexShader: burstV, fragmentShader: burstF,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(this.g, m);
    this.points.frustumCulled = false;
    this.points.renderOrder = 9;
  }
  setScale(s: number) { this.uScale.value = s; }
  /** kind: 0 soft, 1 shard, 2 z glyph */
  emit(p: THREE.Vector3, v: THREE.Vector3, color: THREE.Color, size: number, life: number, kind = 0, gravity = 0) {
    const i = this.next; this.next = (this.next + 1) % this.N;
    this.pos.set([p.x, p.y, p.z], i * 3);
    this.vel.set([v.x, v.y, v.z], i * 3);
    this.col.set([color.r, color.g, color.b], i * 3);
    this.life[i] = 1; this.decay[i] = 1 / life; this.grav[i] = gravity;
    this.data[i * 4] = 1; this.data[i * 4 + 1] = size / 260; this.data[i * 4 + 2] = kind;
  }
  update(dt: number) {
    for (let i = 0; i < this.N; i++) {
      if (this.life[i]! <= 0) continue;
      this.life[i] = this.life[i]! - dt * this.decay[i]!;
      if (this.life[i]! <= 0) { this.data[i * 4] = 0; continue; }
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1]! - this.grav[i]! * dt;
      this.pos[i * 3] = this.pos[i * 3]! + this.vel[i * 3]! * dt;
      this.pos[i * 3 + 1] = this.pos[i * 3 + 1]! + this.vel[i * 3 + 1]! * dt;
      this.pos[i * 3 + 2] = this.pos[i * 3 + 2]! + this.vel[i * 3 + 2]! * dt;
      this.data[i * 4] = this.life[i]!;
    }
    (this.g.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.g.attributes.aData as THREE.BufferAttribute).needsUpdate = true;
    (this.g.attributes.aCol as THREE.BufferAttribute).needsUpdate = true;
  }
  clear() { this.life.fill(0); this.data.fill(0); }
}

/** Three lantern halos as one instanced billboard batch plus flicker. */
export class Lanterns {
  mesh: THREE.InstancedMesh;
  private uI: { value: number };
  constructor(shared: Shared) {
    this.uI = { value: 1 };
    const m = new THREE.ShaderMaterial({
      uniforms: { uCol: shared.uLCol, uI: this.uI },
      vertexShader: `varying vec2 vUv; void main(){ vUv = uv; vec4 c = viewMatrix * modelMatrix * instanceMatrix * vec4(0.,0.,0.,1.); c.xy += position.xy * 3.2; gl_Position = projectionMatrix * c; }`,
      fragmentShader: haloF, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), m, 3);
    LANTERNS.forEach(([x, y, z], i) => this.mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(x, y - 0.2, z)));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 7;
  }
  update(shared: Shared, t: number, calm: boolean) {
    let avg = 0;
    for (let i = 0; i < 3; i++) {
      const f = 0.86 + 0.09 * Math.sin(t * (3.1 + i * 0.9) + i * 2) + 0.05 * Math.sin(t * 11.3 + i * 5);
      shared.uLI.value[i] = calm ? 0.9 : f;
      avg += shared.uLI.value[i]! / 3;
    }
    this.uI.value = avg * 0.85;
  }
}
