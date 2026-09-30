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
  const [autoRenew, setAutoRenew] = useState(false);
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
    void getDocuments(selected?.domain.split(".").pop()).then(setDocs).catch(() => setDocs([]));
    void getContact().then((c) => setHasContact(c.present)).catch(() => setHasContact(false));
  }, [wantsPay, selected?.domain]);
  useEffect(() => { setAccepted(false); setAutoRenew(false); }, [selected?.domain]);
  if (hatchPhase !== "sheet" || !selected) return null;
  const r = selected;
  const years = r.years ?? 1;
  const live = apiReady === true;
  const tld = r.domain.split(".").pop() ?? "";
  const doc = (kind: string) => docs.find((d) => d.kind === kind);
  const addendum = tld === "ai" || tld === "io" ? doc(`tld_addendum_${tld}`) : undefined;
  const authorisation = doc("auto_renew_authorisation");
  const docsReady = !!doc("terms") && !!doc("registration_agreement") && (tld !== "ai" && tld !== "io" ? true : !!addendum);

  const pay = async () => {
    setBusy(true); setError(null);
    try {
      // The acceptance is built from what this sheet showed. The auto-renew text is sent only when its own box is ticked (C-31).
      const accept: Record<string, string> = { terms: doc("terms")!.version, registration_agreement: doc("registration_agreement")!.version };
      if (addendum) accept[addendum.kind] = addendum.version;
      if (autoRenew && authorisation) accept.auto_renew_authorisation = authorisation.version;
      const o = await startCheckout(r.domain, years, accept, autoRenew && !!authorisation);
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
        {tld === "ai" && <p className="notice">.ai is sold for 2 years at a time, so the price is the total for 2 years. Its contact details show in public lookups, and it cannot be refunded.</p>}
        {tld === "io" && <p className="notice">.io follows its registry's own rules, needs at least two nameservers, and cannot be refunded. Its future depends on a treaty about the Chagos Archipelago that is not in force.</p>}
        {/* C-58: .dev and .app are HSTS-preloaded; the same words come with the quote from the server (closure/tld-https.ts). */}
        {(tld === "dev" || tld === "app") && <p className="notice">.{tld} names work only over HTTPS: browsers refuse plain HTTP for every site and subdomain on .{tld}, so each one needs a TLS certificate before it serves anything.</p>}
        {live && account && hasContact && authorisation && (
          <div className="consent" role="group" aria-labelledby="ar-h">
            <h3 id="ar-h">Auto-renew (optional)</h3>
            <p>If you tick this, Stripe keeps your card so we can renew this name each year, ten days before it expires, at the renewal price shown above. You confirm it with your passkey after the name hatches, we email you before every charge, and you can turn it off with one click. <a href={authorisation.url} target="_blank" rel="noreferrer">Read the authorisation</a>.</p>
            <label className="check"><input type="checkbox" checked={autoRenew} onChange={(e) => setAutoRenew(e.target.checked)} /> Save my card for auto-renew. This is separate from the terms.</label>
          </div>
        )}
        <p>No add-ons. Nothing is pre-checked. <a href="/fees.html" target="_blank" rel="noreferrer">Fees, renewals and refunds</a>.</p>
        {live && account && hasContact === false && <ContactForm email={account.user.email} onSaved={() => setHasContact(true)} />}
        {live && account && hasContact && (
          <p>
            <input id="accept" type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} style={{ width: 24, height: 24, verticalAlign: "middle", marginRight: 8 }} />
            <label htmlFor="accept">I accept the <a href={doc("terms")?.url ?? "/legal/terms.html"} target="_blank" rel="noreferrer">terms of service</a>{addendum ? ", " : " and "}the <a href={doc("registration_agreement")?.url ?? "/legal/registration-agreement.html"} target="_blank" rel="noreferrer">registration agreement</a>{addendum && <> and the <a href={addendum.url} target="_blank" rel="noreferrer">.{tld} registry terms</a></>}.</label>
          </p>
        )}
        {error && <p role="alert" className="notice" style={{ color: "var(--st-attention)" }}>{error}</p>}
        <div className="row-actions">
          {!live && <button type="button" className="btn primary" onClick={() => void runHatch(r.domain)}>Hatch</button>}
          {live && account && hasContact && <button type="button" className="btn primary" disabled={busy || !accepted || !docsReady || !quote} onClick={pay}>{busy ? "Opening Stripe" : `Pay ${quote?.subtotal ?? r.price} and hatch`}</button>}
          {live && !account && <button type="button" className="btn primary" onClick={() => set({ accountOpen: true })}>Sign in to hatch</button>}
          <button type="button" className="btn secondary" onClick={() => set({ hatchPhase: "none", selected: null })}>Not yet</button>
        </div>
      </div>
    </aside>
  );
}
