import { createRoot } from "react-dom/client";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import "./styles.css";
import { World, loadKit } from "./world/engine";
import { deriveCreatureSpec, sanitizeSpec, SPECIES, TIER_LABEL, type CreatureState } from "@mosshatch/core";

/**
 * Review tool (?debug=states), not part of production builds.
 * - `&family=<species>`: every state for one species, three coats each (24-creature cap).
 * - `&gallery=a.com,b.ai,...`: those names hatched side by side with labels (species and tier), all thriving.
 * - `&hatch=<name>`: one egg on the pool; `__mh.hatch()` plays its hatch sequence.
 */
const STATES: { s: CreatureState; label: string; days: number }[] = [
  { s: "thriving", label: "Thriving", days: 900 }, { s: "drowsy", label: "Drowsy", days: 400 },
  { s: "sleeping", label: "Sleeping", days: 900 }, { s: "armored", label: "Armored", days: 1500 },
  { s: "shedding", label: "Shedding", days: 200 }, { s: "attention", label: "Needs attention", days: 40 },
  { s: "traveling", label: "Traveling", days: 700 },
];
const NAMES = ["emberwick.com", "lanternfell.ai", "tinkerdeep.dev"];

function Debug() {
  const params = new URLSearchParams(location.search);
  const fam = params.get("family") ?? "fox";
  const gallery = params.get("gallery");
  const hatchName = params.get("hatch");
  const labels = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const canvas = document.querySelector<HTMLCanvasElement>("canvas.world")!;
    let world: World | null = null;
    let off = false;
    void loadKit().then(() => {
      if (off) return;
      const w = new World(canvas, { calm: params.get("calm") === "1", bare: true });
      world = w;
      const fit = () => w.resize(innerWidth, innerHeight);
      fit(); addEventListener("resize", fit);
      if (hatchName) {
        w.setResults([{ domain: hatchName, available: true }]);
      } else if (gallery) {
        const names = gallery.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 24);
        const cols = Math.min(4, names.length);
        const rows = Math.ceil(names.length / cols);
        const zc = 8.6;
        w.layoutFixed(names.map((d, i) => ({ domain: d, state: "thriving" as const, ageDays: 0, x: ((i % cols) - (cols - 1) / 2) * 2.3, z: zc - (Math.floor(i / cols) - (rows - 1) / 2) * 2.2, heading: 0.3 })));
        w.rig.setCustom(new THREE.Vector3(0, 2.6 + rows * 1.1, zc + 5.4 + rows * 1.3), new THREE.Vector3(0, 0.2, zc - 0.2));
        w.overlayMode = "project";
        for (const d of names) {
          const s = deriveCreatureSpec(d);
          const el = document.createElement("div");
          el.className = "debug-label";
          el.style.cssText = "position:fixed;left:0;top:0;font-size:12px;line-height:1.2;text-align:center;color:var(--shell);background:rgba(12,17,34,.72);padding:2px 6px;border-radius:6px;pointer-events:none;white-space:nowrap";
          el.textContent = `${d} · ${s.speciesName} · ${TIER_LABEL[s.tier]}`;
          labels.current?.appendChild(el);
          w.overlay.set(d, el);
        }
      } else {
        const species = (SPECIES as readonly string[]).includes(fam) ? fam : "fox";
        const items = NAMES.flatMap((n, row) => STATES.map((st, col) => ({
          domain: `${n}#${row}`, spec: sanitizeSpec({ ...deriveCreatureSpec(n), species }), state: st.s, ageDays: st.days,
          x: (col - (STATES.length - 1) / 2) * 1.9, z: 9.4 - row * 2.0,
        })));
        w.layoutFixed(items);
        w.rig.setCustom(new THREE.Vector3(0, 3.6, 17.5), new THREE.Vector3(0, 0.7, 7.2));
      }
      w.start();
      (window as unknown as Record<string, unknown>).__mh = {
        world: w, pause: () => w.stop(),
        step: (s: number, dt = 1 / 30) => { for (let t = 0; t < s; t += dt) w.update(dt); w.frame(0.0001); },
        focus: (x: number, z: number, d = 3.2) => { w.rig.setCustom(new THREE.Vector3(x + 0.6, 1.4, z + d), new THREE.Vector3(x, 0.5, z)); },
        hatch: () => { if (hatchName) void w.hatch(hatchName); },
      };
    });
    return () => { off = true; world?.dispose(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <canvas className="world" />
      <div ref={labels} />
      <div className="panel" style={{ position: "fixed", left: 12, top: 12, padding: "8px 14px", zIndex: 5 }}>
        <strong>debug=states</strong> · species:{" "}
        {SPECIES.map((k) => <a key={k} href={`?debug=states&family=${k}`} style={{ color: k === fam && !gallery && !hatchName ? "var(--lantern)" : "var(--shell)", marginRight: 8 }}>{k}</a>)}
        <div style={{ fontSize: 12, opacity: 0.8 }}>{gallery ? "gallery" : hatchName ? `hatch ${hatchName}` : STATES.map((s) => s.label).join(" · ")}</div>
      </div>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Debug />);
