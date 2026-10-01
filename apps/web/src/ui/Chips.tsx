import { useEffect, useRef } from "react";
import { handle } from "../world/handle";
import { useUi, type Result } from "../store";
import { isDemo } from "../lib/site";

/** Registers a DOM element with the world so it is positioned each frame by projection. */
export function useAnchor(id: string, list: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => {
    const w = handle.world, el = ref.current;
    if (!w || !el || list) return;
    w.overlay.set(id, el);
    return () => { w.overlay.delete(id); };
  }, [id, list]);
  return ref;
}

export function Chip({ r, list, row, onPick }: { r: Result; list: boolean; row: number; onPick: (r: Result) => void }) {
  const ref = useAnchor(r.domain, list);
  // Demo mode: registered or not comes from the public registry (real); there is no price before launch.
  const demo = isDemo(useUi((s) => s.apiReady));
  const { label, tld } = { label: r.domain.slice(0, r.domain.indexOf(".")), tld: r.domain.slice(r.domain.indexOf(".")) };
  const style = { "--gap": row } as React.CSSProperties;
  if (r.status === "unknown") {
    return (
      <div ref={ref as React.RefObject<HTMLDivElement>} className="chip unknown" data-row={row} style={style} role="group" aria-label={`${r.domain}: couldn't check right now`}>
        <span><span className="dot" aria-hidden="true" style={{ background: "var(--st-drowsy)" }} /><span className="name">{label}</span><span className="ext">{tld}</span></span>
        <small>Couldn't check right now.</small>
      </div>
    );
  }
  if (!r.available) {
    return (
      <div ref={ref as React.RefObject<HTMLDivElement>} className="chip taken" data-row={row} style={style} role="group" aria-label={`${r.domain} is taken${demo ? ", already registered" : ""}`}>
        <span><span className="dot" aria-hidden="true" style={{ background: "var(--st-sleeping)" }} /><span className="name">{label}</span><span className="ext">{tld}</span></span>
        <small>Taken. Sleeping on the far bank.</small>
      </div>
    );
  }
  if (demo && !r.price) {
    return (
      <button ref={ref as React.RefObject<HTMLButtonElement>} type="button" className="chip" data-row={row} style={style} onClick={() => onPick(r)} aria-label={`${r.domain}, looks unregistered, price at launch. Practice hatch.`}>
        <span><span className="dot" aria-hidden="true" style={{ background: "var(--st-egg)" }} /><span className="name">{label}</span><span className="ext">{tld}</span></span>
        <small>Looks unregistered · price at launch</small>
      </button>
    );
  }
  return (
    <button ref={ref as React.RefObject<HTMLButtonElement>} type="button" className="chip" data-row={row} style={style} onClick={() => onPick(r)} aria-label={`${r.domain}, ${r.price}${r.years === 2 ? " for two years" : ""}, sample price. Hatch it.`}>
      <span><span className="dot" aria-hidden="true" style={{ background: "var(--st-egg)" }} /><span className="name">{label}</span><span className="ext">{tld}</span> <span className="price">{r.price}</span></span>
      <small>{r.years === 2 ? "for 2 years · " : ""}renews the same · <span className="sample-tag">sample price</span></small>
    </button>
  );
}
