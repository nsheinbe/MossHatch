import { useEffect, useRef } from "react";
import type { World } from "../world/engine";
import { handle } from "../world/handle";
import { useUi } from "../store";
import { sound } from "../audio/synth";

/** Owns the canvas and the world's lifetime. Everything visual inside it is imperative three.js. */
export function WorldHost({ onReady, onFail }: { onReady?: (w: World) => void; onFail?: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const canvas = ref.current!;
    let disposed = false;
    let teardown: (() => void) | undefined;
    // The scene is its own chunk: first paint (the HTML and this shell) never waits for three.js.
    // The creature kit is its own chunk, fetched in parallel with the engine.
    void Promise.all([import("../world/engine"), import("../world/creatures/kit")]).then(([{ World, installKit }, kit]) => {
      if (disposed) return;
      installKit(kit);
      let world: World;
      try { world = new World(canvas, { calm: useUi.getState().calm }); } catch { onFail?.(); return; }
      teardown = boot(world);
    }).catch(() => onFail?.());
    return () => { disposed = true; teardown?.(); };

    function boot(world: World) {
    handle.world = world;
    world.hooks = {
      onDrop: () => sound.drop(),
      onTick: (i) => sound.crack(i),
      onFlash: () => { sound.hatch(); if (!useUi.getState().calm) useUi.getState().set({ flash: useUi.getState().flash + 1 }); },
      onLand: () => {},
    };
    const fit = () => world.resize(window.innerWidth, window.innerHeight);
    fit();
    world.start();
    const onVis = () => { if (document.hidden) world.stop(); else world.start(); };
    const onMove = (e: PointerEvent) => world.setPointer(e.clientX, e.clientY);
    const onLeave = () => world.clearPointer();
    const onDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).tagName !== "CANVAS") return;
      const c = world.tap(e.clientX, e.clientY);
      if (!c) return;
      sound.voice(c.spec.species, c.spec.choreography.pitch);
      // In the signed-in grove a creature is its domain: a tap opens the domain's panel, as its chip does.
      const st = useUi.getState();
      const id = st.view === "grove" ? st.groveIndex[c.id] : undefined;
      if (id) st.set({ domainPanel: { id, fqdn: c.id } });
    };
    if (import.meta.env.DEV) {
      // Test hook, present only in the dev server (dead-code-eliminated from builds).
      (window as unknown as Record<string, unknown>).__mh = {
        world,
        pause: () => world.stop(),
        step: (seconds: number, dt = 1 / 30) => { for (let t = 0; t < seconds; t += dt) world.update(dt); world.frame(0.0001); },
      };
    }
    window.addEventListener("resize", fit);
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pointermove", onMove, { passive: true });
    window.addEventListener("pointerdown", onDown);
    document.addEventListener("pointerleave", onLeave);
    onReady?.(world);
    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerleave", onLeave);
      world.dispose();
      handle.world = null;
    };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <canvas ref={ref} className="world" aria-hidden="true" />;
}
