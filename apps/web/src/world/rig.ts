import * as THREE from "three";

export type ViewName = "find" | "grove" | "detail" | "hatch" | "custom";

interface Goal { pos: THREE.Vector3; look: THREE.Vector3 }

/** Goal-and-damp camera: pointer parallax, slow drift, shake decay, fit-to-aspect. */
export class CameraRig {
  camera = new THREE.PerspectiveCamera(42, 1, 0.1, 140);
  private goal: Goal = { pos: new THREE.Vector3(0, 2.4, 7.2), look: new THREE.Vector3(0, 0.9, 0.4) };
  private pos = new THREE.Vector3(0, 2.4, 7.2);
  private look = new THREE.Vector3(0, 0.9, 0.4);
  private pointer = new THREE.Vector2();
  private pointerS = new THREE.Vector2();
  private shakeAmt = 0;
  private aspect = 1;
  calm = false;
  view: ViewName = "find";
  private detailTarget = new THREE.Vector3();
  private sheetOffset = 0; // world-space sideways offset so the subject sits beside the panel

  setPointer(nx: number, ny: number) { this.pointer.set(nx, ny); }
  shake(a: number) { if (!this.calm) this.shakeAmt = Math.max(this.shakeAmt, a); }

  resize(w: number, h: number) {
    this.aspect = w / h;
    this.camera.aspect = this.aspect;
    // Portrait phones widen the FOV and pull back so the pool always fits.
    this.camera.fov = 42 + (1 - Math.min(this.aspect, 1)) * 20;
    this.camera.updateProjectionMatrix();
    this.retarget();
  }

  /** Minimum distance so a half-width of `w` world units fits at this aspect. */
  private fitDistance(w: number): number {
    const t = Math.tan((this.camera.fov * Math.PI) / 360);
    return w / (t * this.aspect);
  }

  setView(v: ViewName, target?: THREE.Vector3, offset = 0) {
    this.view = v;
    if (target) this.detailTarget.copy(target);
    this.sheetOffset = offset;
    this.retarget();
  }

  /** Fixed camera for review pages. */
  setCustom(pos: THREE.Vector3, look: THREE.Vector3) { this.view = "custom"; this.goal.pos.copy(pos); this.goal.look.copy(look); this.snap(); }

  private retarget() {
    if (this.view === "custom") return;
    const portrait = this.aspect < 1;
    switch (this.view) {
      case "find": {
        const d = Math.max(7.2, this.fitDistance(4.4));
        this.goal.pos.set(0, 2.4 + (d - 7.2) * 0.25, d);
        this.goal.look.set(0, portrait ? 0.6 : 0.9, 0.4);
        break;
      }
      case "grove": {
        const d = Math.max(12.5, this.fitDistance(8.5));
        this.goal.pos.set(0, 6.6 + (d - 12.5) * 0.3, d);
        this.goal.look.set(0, 0.2, 0);
        break;
      }
      case "detail": {
        const t = this.detailTarget;
        const d = Math.max(3.4, this.fitDistance(portrait ? 1.1 : 1.6));
        this.goal.pos.set(t.x + this.sheetOffset * 0.6, t.y + 1.1, t.z + d);
        this.goal.look.set(t.x + this.sheetOffset, t.y + (portrait ? 0.35 : 0.5), t.z);
        break;
      }
      case "hatch": {
        const t = this.detailTarget;
        const d = Math.max(3.1, this.fitDistance(1.1));
        this.goal.pos.set(t.x * 0.55, t.y + 1.05, t.z + d);
        this.goal.look.set(t.x, t.y + 0.25, t.z);
        break;
      }
    }
  }

  snap() { this.pos.copy(this.goal.pos); this.look.copy(this.goal.look); }

  update(dt: number, t: number) {
    const k = 1 - Math.exp(-dt * 2.6);
    this.pos.lerp(this.goal.pos, k);
    this.look.lerp(this.goal.look, k);
    this.pointerS.lerp(this.pointer, 1 - Math.exp(-dt * 3));
    const drift = this.calm ? 0 : 1;
    const par = this.calm ? 0.25 : 1;
    const px = this.pointerS.x * 0.35 * par + Math.sin(t * 0.13) * 0.22 * drift;
    const py = this.pointerS.y * 0.15 * par + Math.sin(t * 0.09) * 0.07 * drift;
    this.camera.position.set(this.pos.x + px, this.pos.y + py, this.pos.z);
    this.camera.lookAt(this.look.x, this.look.y, this.look.z);
    if (this.shakeAmt > 0.001) {
      this.camera.position.x += (Math.sin(t * 61) * 0.5 + Math.sin(t * 37)) * 0.03 * this.shakeAmt;
      this.camera.position.y += Math.cos(t * 53) * 0.03 * this.shakeAmt;
      this.shakeAmt *= Math.exp(-dt * 6);
    }
  }
}
