import * as THREE from "three";
import ringV from "../shaders/ring.vert?raw";
import ringF from "../shaders/ring.frag?raw";
import { hatchMaterial, type Shared } from "../materials";
import type { Creature } from "./creature";

const MAX = 24;
const dummy = new THREE.Object3D();
const AMBER = new THREE.Color("#ff9a7e");
const LAV = new THREE.Color("#b9a7ff");

/**
 * Per-state decoration, each one instanced so the draw-call count stays flat:
 * translucent rotating plate shells (armored), crates (traveling) and ground pulse rings (attention, traveling).
 */
export class Decor {
  shells: THREE.InstancedMesh;
  crates: THREE.InstancedMesh;
  rings: THREE.InstancedMesh;
  private ringCol: THREE.InstancedBufferAttribute;
  private ringPhase: THREE.InstancedBufferAttribute;
  constructor(shared: Shared) {
    const shellMat = hatchMaterial(shared, { transparent: true, look: { alpha: 0.32, glow: 0.05 } });
    const shellGeo = new THREE.IcosahedronGeometry(0.62, 1);
    addAttrs(shellGeo, "#9fc8ff");
    shellGeo.computeVertexNormals();
    this.shells = new THREE.InstancedMesh(shellGeo, shellMat, MAX);
    const crateMat = hatchMaterial(shared, { transparent: true, look: { alpha: 0.5 } });
    const crateGeo = new THREE.BoxGeometry(1.0, 0.9, 1.3).toNonIndexed();
    addAttrs(crateGeo, "#8a6a48");
    this.crates = new THREE.InstancedMesh(crateGeo, crateMat, MAX);
    const ringGeo = new THREE.PlaneGeometry(2.6, 2.6).rotateX(-Math.PI / 2);
    this.ringCol = new THREE.InstancedBufferAttribute(new Float32Array(MAX * 3), 3);
    this.ringPhase = new THREE.InstancedBufferAttribute(new Float32Array(MAX), 1);
    ringGeo.setAttribute("iCol", this.ringCol);
    ringGeo.setAttribute("iPhase", this.ringPhase);
    const ringMat = new THREE.ShaderMaterial({
      uniforms: { uTime: shared.uTime }, vertexShader: ringV, fragmentShader: ringF,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.rings = new THREE.InstancedMesh(ringGeo, ringMat, MAX);
    for (const m of [this.shells, this.crates, this.rings]) { m.frustumCulled = false; m.count = 0; }
    this.shells.renderOrder = 6; this.crates.renderOrder = 6; this.rings.renderOrder = 4;
  }

  update(list: Creature[], t: number) {
    let ns = 0, nc = 0, nr = 0;
    for (const c of list) {
      const s = c.state;
      const sz = c.spec.size;
      if (s === "armored" && ns < MAX) {
        dummy.position.set(c.pos.x, c.pos.y + 0.5 * sz, c.pos.z);
        dummy.rotation.set(0, t * 0.6 + ns, 0);
        dummy.scale.set(sz * 1.05, sz * 0.9, sz * 1.3);
        dummy.updateMatrix();
        this.shells.setMatrixAt(ns++, dummy.matrix);
      }
      if (s === "traveling" && nc < MAX) {
        dummy.position.set(c.pos.x, c.pos.y + 0.45 * sz, c.pos.z);
        dummy.rotation.set(0, c.heading, 0);
        dummy.scale.setScalar(sz);
        dummy.updateMatrix();
        this.crates.setMatrixAt(nc++, dummy.matrix);
      }
      if ((s === "attention" || s === "traveling") && nr < MAX) {
        dummy.position.set(c.pos.x, 0.04, c.pos.z);
        dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(1);
        dummy.updateMatrix();
        this.rings.setMatrixAt(nr, dummy.matrix);
        const col = s === "attention" ? AMBER : LAV;
        this.ringCol.setXYZ(nr, col.r, col.g, col.b);
        this.ringPhase.setX(nr, (nr * 0.37) % 1);
        nr++;
      }
    }
    this.shells.count = ns; this.crates.count = nc; this.rings.count = nr;
    this.shells.instanceMatrix.needsUpdate = true; this.crates.instanceMatrix.needsUpdate = true;
    this.rings.instanceMatrix.needsUpdate = true; this.ringCol.needsUpdate = true; this.ringPhase.needsUpdate = true;
  }
}

function addAttrs(g: THREE.BufferGeometry, color: string) {
  const n = g.attributes.position!.count;
  const c = new THREE.Color(color);
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute("aColor", new THREE.BufferAttribute(col, 3));
  g.setAttribute("aSway", new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setAttribute("aEmit", new THREE.BufferAttribute(new Float32Array(n), 1));
  g.deleteAttribute("uv");
}
