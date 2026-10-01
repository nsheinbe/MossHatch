import { useEffect, type RefObject } from "react";
import { useUi } from "../store";
import { handle } from "../world/handle";

const WORD = "moonfern";

/**
 * The Arrival demo: types "moonfern", eggs rise, one hatches and walks into the trees, then it resets.
 * Any input cancels it at once. Skipped in Calm mode and for anyone who has already typed.
 */
export function useArrivalDemo(inputRef: RefObject<HTMLInputElement | null>) {
  useEffect(() => {
    const st = useUi.getState;
    // The demo is for first visits. A return from Checkout has its own hatch to run.
    if (st().demo !== "idle" || st().calm || location.pathname === "/checkout/return") return;
    let cancelled = false;
    const timers: number[] = [];
    const at = (ms: number, fn: () => void) => { timers.push(window.setTimeout(() => { if (!cancelled) fn(); }, ms)); };

    const cancel = (fromKey: boolean) => {
      if (cancelled) return;
      cancelled = true;
      timers.forEach(clearTimeout);
      remove();
      const w = handle.world;
      w?.cancelHatch();
      if (w) for (const c of [...w.groveCreatures()]) if (c.id.startsWith(WORD)) w.removeGrove(c.id);
      // Clear the demo text before the key that cancelled it lands in the field.
      if (inputRef.current && fromKey) inputRef.current.value = "";
      st().set({ demo: "done", query: "", results: [], alternatives: [], hatchPhase: "none", selected: null });
      w?.clearResults();
    };
    const onKey = () => cancel(true);
    const onPtr = (e: Event) => { if ((e.target as HTMLElement | null)?.closest?.(".site-header")) return; cancel(false); };
    const remove = () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onPtr, true);
      document.removeEventListener("wheel", onPtr, true);
    };
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onPtr, true);
    document.addEventListener("wheel", onPtr, true);

    at(1500, () => {
      if (!handle.world) return;
      st().set({ demo: "playing" });
      [...WORD].forEach((_, i) => at(i * 190, () => { st().set({ query: WORD.slice(0, i + 1) }); handle.world?.keystroke(); }));
      const typed = WORD.length * 190;
      at(typed + 2600, async () => {
        const w = handle.world; if (!w) return;
        const pick = st().results.find((r) => r.available && r.domain === `${WORD}.com`) ?? st().results.find((r) => r.available);
        if (!pick) return cancel(false);
        st().set({ hatchPhase: "hatching" });
        try {
          const c = await w.hatch(pick.domain, { demo: true });
          if (cancelled) return;
          w.adopt(c);
          w.setView("find");
          const a = Math.random() < 0.5 ? -1 : 1;
          c.goTo(a * 9, -7);
          at(6500, () => {
            w.removeGrove(c.id);
            st().set({ demo: "done", query: "", results: [], alternatives: [], hatchPhase: "none", selected: null });
            w.clearResults();
            remove();
          });
        } catch { cancel(false); }
      });
    });
    return () => { cancelled = true; timers.forEach(clearTimeout); remove(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
