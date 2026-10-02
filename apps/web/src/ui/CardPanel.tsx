import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { PracticeHatchNotice } from "./DemoNotice";

export function CardPanel() {
  const { card, hatchPhase, set } = useUi();
  const head = useRef<HTMLHeadingElement>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { if (hatchPhase === "card") head.current?.focus(); }, [hatchPhase]);
  if (hatchPhase !== "card" || !card) return null;
  const again = () => {
    set({ hatchPhase: "none", selected: null, card: null, query: "", results: [], alternatives: [] });
    handle.world?.clearResults();
    handle.world?.setView("find");
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(`https://${card.address}`); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { setCopied(false); }
  };
  return (
    <aside className="panel side" role="region" aria-label={`${card.domain} has hatched`}>
      <div className="head"><h2 ref={head} tabIndex={-1}>{card.domain} hatched</h2></div>
      <div className="body">
        <PracticeHatchNotice domain={card.domain} />
        {card.practice && <p className="notice"><span className="sample-tag">Practice hatch.</span> Nothing was bought, and {card.domain} is not registered to you.</p>}
        <img className="card-img" src={card.image} alt={`Portrait of ${card.domain}, a ${card.species}`} width={512} height={640} />
        <p className={`tier tier-${card.tier}`} style={{ marginTop: 10 }}><strong>{card.tierLabel}</strong></p>
        <p className="fineprint">Short, clean names hatch rarer creatures.</p>
        <p><strong>{card.species}</strong>. Hatched {card.hatchedOn}.</p>
        {card.bio && <p>{card.bio}</p>}
        <ul className="traits">{card.traits.map((t) => <li key={t}>{t}</li>)}</ul>
        <p>{card.moss}</p>
        <p className="notice">Its card address will be <span style={{ fontWeight: 700 }}>{card.address}</span>. Cards are not live yet.</p>
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={() => set({ talk: { domain: card.domain, source: "practice" }, hatchPhase: "none" })}>Talk to {card.species}</button>
          <button type="button" className="btn secondary" onClick={again}>Hatch another</button>
          <button type="button" className="btn secondary" onClick={copy}>{copied ? "Copied" : "Copy card link"}</button>
        </div>
      </div>
    </aside>
  );
}
