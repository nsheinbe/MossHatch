import * as THREE from "three";

// Shaders write final sRGB values directly, so keep authored colours as authored.
THREE.ColorManagement.enabled = false;
import common from "./shaders/common.glsl?raw";
import hatchVert from "./shaders/hatch.vert?raw";
import hatchFrag from "./shaders/hatch.frag?raw";

/** Design tokens (brief section 4). */
export const TOKENS = {
  night: "#131a33", canopy: "#16302b", moss: "#9dbb55", lantern: "#ffb257",
  shell: "#f1ead8", pool: "#3a9a98", ink: "#0c1122",
} as const;

export interface Shared {
  uTime: { value: number };
  uDpr: { value: number };
  uMoonDir: { value: THREE.Vector3 };
  uSkyTop: { value: THREE.Color };
  uSkyHor: { value: THREE.Color };
  uLP: { value: THREE.Vector3[] };
  uLI: { value: number[] };
  uLCol: { value: THREE.Color };
  uFogCol: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  uInk: { value: THREE.Color };
  uCalm: { value: number };
}

export function makeShared(): Shared {
  return {
    uTime: { value: 0 },
    uDpr: { value: 1 },
    uMoonDir: { value: new THREE.Vector3(0.42, 0.34, -0.84).normalize() },
    uSkyTop: { value: new THREE.Color(TOKENS.night) },
    uSkyHor: { value: new THREE.Color("#3b3f73") },
    uLP: { value: [new THREE.Vector3(-4.4, 1.7, 1.2), new THREE.Vector3(4.6, 1.8, 0.4), new THREE.Vector3(0.6, 1.9, -4.8)] },
    uLI: { value: [1, 1, 1] },
    uLCol: { value: new THREE.Color(TOKENS.lantern) },
    uFogCol: { value: new THREE.Color("#2b3560") },
    uFogNear: { value: 11 },
    uFogFar: { value: 52 },
    uInk: { value: new THREE.Color(TOKENS.ink) },
    uCalm: { value: 0 },
  };
}

export interface HatchLook {
  moss?: number; desat?: number; sleep?: number; attn?: number; shed?: number; glow?: number; alpha?: number; tint?: number;
}

/** The hatch material. `creature` enables vertex-animated parts; `instanced` enables instanceMatrix. */
export function hatchMaterial(shared: Shared, opts: { creature?: boolean; egg?: boolean; look?: HatchLook; transparent?: boolean } = {}): THREE.ShaderMaterial {
  const l = opts.look ?? {};
  const defines: Record<string, string> = {};
  if (opts.creature) defines.CREATURE = "";
  if (opts.egg) defines.EGG = "";
  const m = new THREE.ShaderMaterial({
    defines,
    uniforms: {
      ...shared,
      uMoss: { value: l.moss ?? 0 }, uDesat: { value: l.desat ?? 0 }, uSleep: { value: l.sleep ?? 0 },
      uAttn: { value: l.attn ?? 0 }, uShed: { value: l.shed ?? 0 }, uGlow: { value: l.glow ?? 0 },
      uAlpha: { value: l.alpha ?? 1 }, uTint: { value: l.tint ?? 0 },
      uPose: { value: new THREE.Vector4() }, uPose2: { value: new THREE.Vector4(0, 1, 0, 0) }, uWave: { value: 0 },
      uPose3: { value: new THREE.Vector4() }, uHeadPivot: { value: new THREE.Vector3() },
      uRimCol: { value: new THREE.Color(0, 0, 0) }, uRimK: { value: 0 }, uIri: { value: 0 },
      uShellA: { value: new THREE.Color(TOKENS.shell) }, uShellB: { value: new THREE.Color(TOKENS.shell) }, uShellPat: { value: 0 },
      uCrack: { value: 0 }, uCrackKind: { value: 0 },
    },
    vertexShader: hatchVert,
    fragmentShader: common + hatchFrag,
    transparent: opts.transparent ?? false,
    depthWrite: !opts.transparent,
    side: opts.creature ? THREE.DoubleSide : THREE.FrontSide,
  });
  return m;
}

export { common as commonGlsl };
