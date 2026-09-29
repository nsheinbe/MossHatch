import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import * as THREE from "three";
import "./styles.css";
import { World } from "./world/engine";
import type { CreatureState } from "@mosshatch/core";

/**
 * Review tool (?debug=states): every family in every state, one family per page so the animated
 * creature count stays inside the 24-creature cap. Not part of production builds.
 */
const STATES: { s: CreatureState; label: string; days: number }[] = [
  { s: "thriving", label: "Thriving", days: 900 }, { s: "drowsy", label: "Drowsy", days: 400 },
  { s: "sleeping", label: "Sleeping", days: 900 }, { s: "armored", label: "Armored", days: 1500 },
  { s: "shedding", label: "Shedding", days: 200 }, { s: "attention", label: "Needs attention", days: 40 },
  { s: "traveling", label: "Traveling", days: 700 },
];
const FAMILIES: Record<string, { ext: string; names: string[] }> = {
  fox: { ext: "com", names: ["emberwick", "moonfern", "sootmarrow"] },
  moth: { ext: "ai", names: ["lanternfell", "glowmere", "duskwing"] },
  beetle: { ext: "dev", names: ["tinkerdeep", "brassnook", "gearhollow"] },
  koi: { ext: "io", names: ["marrowbrook", "clockpond", "tideloom"] },
  app: { ext: "app", names: ["hollowmint", "paperwren", "quillnest"] },
  studio: { ext: "studio", names: ["stillwater", "inkmoth", "lampfern"] },
};

function Debug() {
  const params = new URLSearchParams(location.search);
  const fam = params.get("family") ?? "fox";
  const [w, setW] = useState<World | null>(null);
  useEffect(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.world")!;
    const world = new World(canvas, { calm: false, bare: true });
    const fit = () => world.resize(innerWidth, innerHeight);
    fit(); addEventListener("resize", fit);
    const f = FAMILIES[fam] ?? FAMILIES.fox!;
    const items = f.names.flatMap((n, row) => STATES.map((st, col) => ({
      domain: `${n}.${f.ext}`, state: st.s, ageDays: st.days,
      x: (col - (STATES.length - 1) / 2) * 1.9, z: 9.4 - row * 2.0,
    })));
    world.layoutFixed(items);
    // Fixed review camera in front of the pool.
    world.rig.setCustom(new THREE.Vector3(0, 3.6, 17.5), new THREE.Vector3(0, 0.7, 7.2));
    world.start();
    (window as unknown as Record<string, unknown>).__mh = {
      world, pause: () => world.stop(),
      step: (s: number, dt = 1 / 30) => { for (let t = 0; t < s; t += dt) world.update(dt); world.frame(0.0001); },
      focus: (x: number, z: number, d = 3.2) => { world.rig.setCustom(new THREE.Vector3(x + 0.6, 1.4, z + d), new THREE.Vector3(x, 0.5, z)); },
    };
    setW(world);
    return () => world.dispose();
  }, [fam]);
  void w;
  return (
    <>
      <canvas className="world" />
      <div className="panel" style={{ position: "fixed", left: 12, top: 12, padding: "8px 14px", zIndex: 5 }}>
        <strong>debug=states</strong> · family:{" "}
        {Object.keys(FAMILIES).map((k) => <a key={k} href={`?debug=states&family=${k}`} style={{ color: k === fam ? "var(--lantern)" : "var(--shell)", marginRight: 8 }}>{k}</a>)}
        <div style={{ fontSize: 12, opacity: 0.8 }}>{STATES.map((s) => s.label).join(" · ")}</div>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Debug />);
