import { useEffect, useRef } from "react";
import { deriveTraits, ageInWords, mossFromAge } from "@mosshatch/core";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { sound } from "../audio/synth";

/** Checkout panel. In Phase 1 there is no payment: "Hatch" is a practice hatch. */
export function HatchSheet() {
  const { selected, hatchPhase, set } = useUi();
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (hatchPhase === "sheet") head.current?.focus(); }, [hatchPhase]);
  useEffect(() => {
    if (hatchPhase !== "sheet") return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") set({ hatchPhase: "none", selected: null }); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [hatchPhase, set]);
  if (hatchPhase !== "sheet" || !selected) return null;
  const r = selected;
  const years = r.years ?? 1;

  const hatch = async () => {
    const w = handle.world; if (!w) return;
    set({ hatchPhase: "hatching" });
    try {
      const c = await w.hatch(r.domain);
      const traits = deriveTraits(r.domain);
      const image = w.snapshot(c);
      const now = new Date();
      w.adopt(c);
      sound.voice(traits.family, traits.pitch);
      c.hop();
      set({
        hatchPhase: "card",
        groveNames: [...useUi.getState().groveNames, r.domain],
        card: {
          domain: r.domain, image, species: traits.speciesName,
          traits: [`${traits.rarity} coat`, `${traits.earLength > 1.1 ? "long" : "short"} ears`, `${traits.tailLength > 1.15 ? "long" : "short"} tail`, `${traits.spots} ${traits.spots === 1 ? "spot" : "spots"}`],
          hatchedOn: now.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
          moss: `${ageInWords(0)} (moss ${Math.round(mossFromAge(0) * 100)}%)`,
          address: `hatchkind.com/${r.domain}`,
        },
      });
    } catch { set({ hatchPhase: "sheet" }); }
  };

  return (
    <aside className="panel side" role="region" aria-label={`Hatch ${r.domain}`}>
      <div className="head"><h2 ref={head} tabIndex={-1}>{r.domain}</h2></div>
      <div className="body">
        <p className="notice"><span className="sample-tag">Preview.</span> Nothing is bought or charged. Prices are sample prices.</p>
        <dl className="rows">
          <dt>{years === 2 ? "First 2 years" : "First year"}</dt><dd>{r.price}</dd>
          <dt>Renews at</dt><dd>{years === 2 ? `${r.price} per 2 years` : r.price} (same)</dd>
          <dt>WHOIS privacy</dt><dd>Free</dd>
          <dt className="total">Total today</dt><dd className="total">{r.price}</dd>
        </dl>
        <details>
          <summary>How the price is made</summary>
          <dl className="rows" style={{ marginTop: 8 }}>
            <dt>Registry cost</dt><dd>{r.wholesale}</dd>
            <dt>Flat fee</dt><dd>{r.fee}</dd>
          </dl>
        </details>
        <p>No add-ons. Nothing is pre-checked.</p>
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={hatch}>Hatch</button>
          <button type="button" className="btn secondary" onClick={() => set({ hatchPhase: "none", selected: null })}>Not yet</button>
        </div>
      </div>
    </aside>
  );
}
