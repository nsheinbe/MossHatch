import { useEffect, useRef } from "react";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { listDomains } from "../lib/domains";
import { isDemo } from "../lib/site";
import { PracticeHatchNotice } from "./DemoNotice";

export function CardPanel() {
  const { card, hatchPhase, apiReady, set } = useUi();
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (hatchPhase === "card") head.current?.focus(); }, [hatchPhase]);
  if (hatchPhase !== "card" || !card) return null;
  const again = () => {
    set({ hatchPhase: "none", selected: null, card: null, query: "", results: [], alternatives: [] });
    handle.world?.clearResults();
    handle.world?.setView("find");
  };
  return (
    <aside className="panel side" role="region" aria-label={`${card.domain} has hatched`}>
      <div className="head"><h2 ref={head} tabIndex={-1}>{card.domain} hatched</h2></div>
      <div className="body">
        <PracticeHatchNotice domain={card.domain} />
        {/* The card is the 1024 x 1280 picture with a 200-pixel caption band under it (world/portrait.ts), shown at half size. */}
        <img className="card-img" src={card.image} alt={`Portrait of ${card.domain}, a ${card.species}, captioned with the name and hatch date`} width={512} height={740} />
        <p className={`tier tier-${card.tier}`} style={{ marginTop: 10 }}><strong>{card.tierLabel}</strong></p>
        <p className="fineprint">Short, clean names hatch rarer creatures.</p>
        <p><strong>{card.species}</strong>. Hatched {card.hatchedOn}.</p>
        {card.bio && <p>{card.bio}</p>}
        <ul className="traits">{card.traits.map((t) => <li key={t}>{t}</li>)}</ul>
        <p>{card.moss}</p>
        <p className="notice">{isDemo(apiReady) ? "Keep a picture of your creature. Downloading the portrait does not register or reserve the domain." : "Your domain is registered, and your receipt is on its way by email (look in Junk if it is not there in a minute). Open the domain’s Overview to connect a website, manage renewals or publish your creature’s page."}</p>
        <div className="row-actions">
          {!isDemo(apiReady) && <button type="button" className="btn primary" onClick={() => { void listDomains().then(all => { const d = all.domains.find(d => d.fqdn === card.domain); if (d) set({ hatchPhase: "none", card: null, orderId: null, orderSession: null, domainPanel: { id: d.id, fqdn: d.fqdn } }); }).catch(() => set({ view: "ledger", hatchPhase: "none", card: null })); }}>Set up my domain</button>}
          <button type="button" className="btn primary" onClick={again}>Hatch another</button>
          <a className="btn secondary" href={card.image} download={`${card.domain}-mosshatch.png`}>Download portrait</a>
        </div>
      </div>
    </aside>
  );
}

