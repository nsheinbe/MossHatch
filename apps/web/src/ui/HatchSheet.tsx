import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { getContact, getDocuments, startCheckout, type LegalDoc } from "../lib/orders";
import { liveQuote, type LiveQuote } from "../lib/find";
import { ContactForm } from "./ContactForm";
import { explain } from "../lib/account";
import { runHatch } from "./hatchFlow";

/**
 * Checkout panel. With accounts connected and a signed-in person, the primary button pays on Stripe (the price is the server's).
 * Without a connected deployment it stays the practice hatch from Phase 1: nothing is bought.
 */
export function HatchSheet() {
  const { selected, hatchPhase, apiReady, account, set } = useUi();
  const head = useRef<HTMLHeadingElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [docs, setDocs] = useState<LegalDoc[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [hasContact, setHasContact] = useState<boolean | null>(null);
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  useEffect(() => { if (hatchPhase === "sheet") head.current?.focus(); }, [hatchPhase]);
  useEffect(() => {
    if (hatchPhase !== "sheet") return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") set({ hatchPhase: "none", selected: null }); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [hatchPhase, set]);
  const wantsPay = hatchPhase === "sheet" && apiReady === true && !!account;
  const quoteFor = hatchPhase === "sheet" && apiReady === true ? selected?.domain : undefined;
  useEffect(() => {
    if (!quoteFor) { setQuote(null); return; }
    void liveQuote(quoteFor, selected?.years ?? 1).then(setQuote).catch(() => setQuote(null));
  }, [quoteFor, selected?.years]);
  useEffect(() => {
    if (!wantsPay) return;
    void getDocuments().then(setDocs).catch(() => setDocs([]));
    void getContact().then((c) => setHasContact(c.present)).catch(() => setHasContact(false));
  }, [wantsPay]);
  if (hatchPhase !== "sheet" || !selected) return null;
  const r = selected;
  const years = r.years ?? 1;
  const live = apiReady === true;

  const pay = async () => {
    setBusy(true); setError(null);
    try {
      const o = await startCheckout(r.domain, years, Object.fromEntries(docs.map((d) => [d.kind, d.version])));
      sessionStorage.setItem("mh.order", o.order_id);
      window.location.assign(o.checkout_url);
    } catch (e) { setError(explain(e)); setBusy(false); }
  };

  return (
    <aside className="panel side" role="region" aria-label={`Hatch ${r.domain}`}>
      <div className="head"><h2 ref={head} tabIndex={-1}>{r.domain}</h2></div>
      <div className="body">
        {live
          ? <p className="notice">You pay on Stripe next. Nothing is charged until the name is registered.</p>
          : <p className="notice"><span className="sample-tag">Preview.</span> Nothing is bought or charged. Prices are sample prices.</p>}
        <dl className="rows">
          <dt>{years === 2 ? "First 2 years" : "First year"}</dt><dd>{quote?.subtotal ?? r.price}</dd>
          <dt>Renews at</dt><dd>{years === 2 ? `${quote?.subtotal ?? r.price} per 2 years` : (quote?.subtotal ?? r.price)} (same)</dd>
          <dt>WHOIS privacy</dt><dd>Free</dd>
          <dt className="total">{live ? "Total before tax" : "Total today"}</dt><dd className="total">{quote?.subtotal ?? r.price}</dd>
        </dl>
        <details>
          <summary>How the price is made</summary>
          <dl className="rows" style={{ marginTop: 8 }}>
            <dt>Registry cost</dt><dd>{quote?.wholesale ?? r.wholesale}</dd>
            <dt>Flat fee</dt><dd>{quote?.fee ?? r.fee}</dd>
          </dl>
        </details>
        <p>No add-ons. Nothing is pre-checked.</p>
        {live && account && hasContact === false && <ContactForm email={account.user.email} onSaved={() => setHasContact(true)} />}
        {live && account && hasContact && (
          <p>
            <input id="accept" type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} style={{ width: 24, height: 24, verticalAlign: "middle", marginRight: 8 }} />
            <label htmlFor="accept">I accept the <a href={docs.find((d) => d.kind === "terms")?.url ?? "/legal/terms.html"} target="_blank" rel="noreferrer">terms of service</a> and the <a href={docs.find((d) => d.kind === "registration_agreement")?.url ?? "/legal/registration-agreement.html"} target="_blank" rel="noreferrer">registration agreement</a>.</label>
          </p>
        )}
        {error && <p role="alert" className="notice" style={{ color: "var(--st-attention)" }}>{error}</p>}
        <div className="row-actions">
          {!live && <button type="button" className="btn primary" onClick={() => void runHatch(r.domain)}>Hatch</button>}
          {live && account && hasContact && <button type="button" className="btn primary" disabled={busy || !accepted || docs.length < 2 || !quote} onClick={pay}>{busy ? "Opening Stripe" : `Pay ${quote?.subtotal ?? r.price} and hatch`}</button>}
          {live && !account && <button type="button" className="btn primary" onClick={() => set({ accountOpen: true })}>Sign in to hatch</button>}
          <button type="button" className="btn secondary" onClick={() => set({ hatchPhase: "none", selected: null })}>Not yet</button>
        </div>
      </div>
    </aside>
  );
}
