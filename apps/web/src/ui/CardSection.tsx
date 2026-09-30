import { useCallback, useEffect, useState } from "react";
import { explainDomain } from "../lib/domains";
import { ApiError } from "../lib/api";
import { getCard, publishCard, renderPortrait, unpublishCard, type CardInfo } from "../lib/cards";
import { StepUp, type StepUpRequest } from "./StepUp";

/**
 * The domain's public card on hatchkind.com (D-012, D-035). Publishing is a passkey step-up that signs the portrait's hash and the
 * search-listing choice; taking it down is one click. The card shows the name, computed traits and the hatch date, nothing else.
 */
const CARD_ERRORS: Record<string, string> = {
  card_screen_refused: "This name can't have a public card. Names that look like a well-known brand, mix alphabets, or appear on a safety list are refused.",
  card_publish_blocked: "Publishing cards is switched off for this account after earlier take-downs. Write to support@mosshatch.com to ask about it.",
  screen_unavailable: "The safety check is not answering. Try again in a few minutes.",
  publish_not_configured: "Public cards are not switched on here yet.",
  invalid_image: "The portrait could not be prepared in this browser. Try again, or use another browser.",
};
const explain = (e: unknown) => (e instanceof ApiError && CARD_ERRORS[e.code]) || explainDomain(e);

export function CardSection({ domainId, fqdn }: { domainId: string; fqdn: string }) {
  const [info, setInfo] = useState<CardInfo | null>(null);
  const [listed, setListed] = useState(false);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => { getCard(domainId).then(setInfo).catch((e) => setMsg(explain(e))); }, [domainId]);
  useEffect(load, [load]);
  if (!info) return msg ? <p role="alert" className="notice">{msg}</p> : null;

  const start = async () => {
    setMsg(null);
    try {
      const p = await renderPortrait(fqdn);
      setReq({ type: "card.publish", target: domainId, input: { image_sha256: p.sha256, indexable: listed },
        run: async (id) => { await publishCard(domainId, p.png, listed, id); setMsg("Your card is published. It appears on hatchkind.com after the next update, within a few minutes."); } });
    } catch (e) { setMsg(explain(e)); }
  };
  const takeDown = async () => {
    setMsg(null);
    try { await unpublishCard(domainId); setMsg("Your card is taken down."); load(); } catch (e) { setMsg(explain(e)); }
  };

  return (
    <section className="card-section" aria-labelledby="card-h">
      <h3 id="card-h">Public card</h3>
      {info.card ? (
        <>
          <p>Published at <strong>{info.card.url.replace(/^https:\/\//, "")}</strong>. {info.card.indexable ? "Search engines may list it." : "Search engines are asked not to list it."}</p>
          <div className="row-actions"><button type="button" className="btn secondary" onClick={() => void takeDown()}>Take the card down</button></div>
        </>
      ) : info.eligible ? (
        <>
          <p>Share this domain's creature at <strong>{info.address.replace(/^https:\/\//, "")}</strong>. The card shows the name, its creature and the hatch date. It never shows your name or email.</p>
          <p><label className="check"><input type="checkbox" checked={listed} onChange={(e) => setListed(e.target.checked)} /> Let search engines list this card</label></p>
          {!req && <div className="row-actions"><button type="button" className="btn primary" onClick={() => void start()}>Publish card</button></div>}
        </>
      ) : <p>This domain cannot have a public card right now.</p>}
      {req && <StepUp req={req} onDone={() => { setReq(null); load(); }} />}
      {msg && <p role="status" className="notice">{msg}</p>}
    </section>
  );
}
