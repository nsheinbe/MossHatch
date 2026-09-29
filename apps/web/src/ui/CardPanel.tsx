import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { handle } from "../world/handle";

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
        <img className="card-img" src={card.image} alt={`Portrait of ${card.domain}, a ${card.species}`} width={512} height={640} />
        <p style={{ marginTop: 10 }}><strong>{card.species}</strong>. Hatched {card.hatchedOn}.</p>
        <ul className="traits">{card.traits.map((t) => <li key={t}>{t}</li>)}</ul>
        <p>{card.moss}</p>
        <p className="notice">Its card address will be <span style={{ fontWeight: 700 }}>{card.address}</span>. Cards are not live yet.</p>
        <div className="row-actions">
          <button type="button" className="btn primary" onClick={again}>Hatch another</button>
          <button type="button" className="btn secondary" onClick={copy}>{copied ? "Copied" : "Copy card link"}</button>
        </div>
      </div>
    </aside>
  );
}
