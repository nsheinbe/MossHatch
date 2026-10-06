import { useEffect, useRef, useState } from "react";
import { useUi, type Result } from "../store";
import { getContact, getDocuments, startCheckout, type LegalDoc } from "../lib/orders";
import { liveQuote, type LiveQuote } from "../lib/find";
import { ContactForm } from "./ContactForm";
import { explain } from "../lib/account";
import { runHatch } from "./hatchFlow";
import { PracticeHatchNotice } from "./DemoNotice";
import { OwnershipPreview } from "./OwnershipPreview";
import { handle } from "../world/handle";
import { trackConversion, attribution } from "../lib/conversion";

export function HatchSheet() {
  const { selected, hatchPhase, account } = useUi();
  if (hatchPhase !== "sheet" || !selected) return null;
  // A selection/account change starts a clean quote and consent state. Late responses cannot price another domain.
  return <CheckoutSheet key={`${selected.domain}:${account?.user.id ?? 'guest'}`} r={selected} />;
}
function CheckoutSheet({ r }: { r: Result }) {
  const { apiReady, account, accountOpen, set } = useUi();
  const live = apiReady === true;
  const head = useRef<HTMLHeadingElement>(null);
  const inFlight = useRef(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [docs, setDocs] = useState<LegalDoc[]>([]);
  const [accepted, setAccepted] = useState(false);
  const [autoRenew, setAutoRenew] = useState(false);
  const [hasContact, setHasContact] = useState<boolean | null>(null);
  const [quote, setQuote] = useState<LiveQuote | null>(null);
  const [loading, setLoading] = useState(live);
  const [revision, setRevision] = useState(0);
  const [expired, setExpired] = useState(false);
  const tld = r.tld;
  const years = r.years ?? 1;
  useEffect(() => { head.current?.focus(); const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !inFlight.current) set({ hatchPhase: "none", selected: null }); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [set]);
  useEffect(() => {
    if (!live) return;
    let active = true;
    setQuote(null); setDocs([]); setLoading(true); setLoadError(null); setExpired(false); setAccepted(false);
    void Promise.all([liveQuote(r.domain, years), account ? getDocuments(tld) : Promise.resolve([]), account ? getContact() : Promise.resolve(null)]).then(([q, documents, contact]) => {
      if (!active) return;
      if (!q) setLoadError("We couldn't confirm this name and price. Refresh the quote before continuing.");
      setQuote(q); setDocs(documents); setHasContact(contact?.present ?? null); setLoading(false);
    }).catch(() => { if (active) { setLoading(false); setLoadError("We couldn't load checkout. Your domain hasn't been purchased. Please retry."); } });
    return () => { active = false; };
  }, [live, r.domain, years, tld, account, revision]);
  useEffect(() => {
    if (!quote) return;
    const remaining = Date.parse(quote.expiresAt) - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) { setExpired(true); return; }
    const timer = window.setTimeout(() => setExpired(true), remaining);
    return () => window.clearTimeout(timer);
  }, [quote]);
  const doc = (kind: string) => docs.find(d => d.kind === kind);
  const addendum = tld === "ai" || tld === "io" ? doc(`tld_addendum_${tld}`) : undefined;
  const authorisation = doc("auto_renew_authorisation");
  const docsReady = !!doc("terms") && !!doc("registration_agreement") && (!(tld === "ai" || tld === "io") || !!addendum);
  const quoteReady = !!quote && quote.domain === r.domain && !expired && Date.parse(quote.expiresAt) > Date.now();
  const total = live ? quote?.subtotal : r.price;
  const pay = async () => {
    if (inFlight.current || !quoteReady || !accepted || !docsReady || !hasContact) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const accept: Record<string,string> = { terms: doc('terms')!.version, registration_agreement: doc('registration_agreement')!.version };
      if (addendum) accept[addendum.kind] = addendum.version;
      if (autoRenew && authorisation) accept.auto_renew_authorisation = authorisation.version;
      const signature = JSON.stringify([r.domain, years, accept, autoRenew]);
      if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
      trackConversion('checkout', false);
      const o = await startCheckout(r.domain, years, accept, autoRenew && !!authorisation, attempt.current.key);
      // Attribution cannot block or duplicate checkout. Only coarse campaign/device labels are sent.
      void attribution(o.order_id);
      try { sessionStorage.setItem('mh.order', o.order_id); } catch { /* private browsing can disable storage */ }
      window.location.assign(o.checkout_url);
    } catch (e) { setError(explain(e)); setBusy(false); inFlight.current = false; }
  };
  return <aside className="panel side checkout-sheet" role="region" aria-label={`Hatch ${r.domain}`} hidden={accountOpen}>
    <div className="head"><h2 ref={head} tabIndex={-1}>{r.domain}</h2></div>
    <div className="body">
      <OwnershipPreview domain={r.domain} />
      <PracticeHatchNotice domain={r.domain} />
      <p className="notice">{live ? 'Review your domain, then continue to secure payment on Stripe. Registration is confirmed before your creature hatches.' : 'Preview only. A practice hatch does not purchase or reserve this name.'}</p>
      <dl className="rows">
        <dt>{years === 2 ? 'First 2 years' : 'First year'}</dt><dd>{total ?? (loading ? 'Checking…' : 'Unavailable')}</dd>
        <dt>Current renewal</dt><dd>{live ? quote?.subtotal ?? 'Checking…' : r.renewal ?? r.price ?? 'At launch'} / {years === 2 ? '2 years' : 'year'}</dd>
        <dt>Registrant privacy</dt><dd>{tld === 'ai' ? 'Public registry details' : 'Included where supported'}</dd>
        <dt className="total">{live ? 'Subtotal before tax' : 'Published test price'}</dt><dd className="total">{total ?? 'Unavailable'}</dd>
      </dl>
      <p className="fineprint">{live ? 'Any applicable tax and the final total are shown on Stripe before you confirm. Future registry price changes may affect renewal; review the fees policy.' : 'Invite-only test pricing. Public launch prices may change.'}</p>
      {live && quote && <details><summary>How the price is made</summary><dl className="rows"><dt>Registrar pricing</dt><dd>{quote.wholesale}</dd><dt>MossHatch fee</dt><dd>{quote.fee}</dd></dl>{quote.heldAtRenewal && <p className="fineprint">The first term uses the current renewal pricing level, so a first-year discount doesn't hide a higher renewal.</p>}</details>}
      {tld === 'ai' && <p className="notice">.ai is sold in 2-year terms. Registrant contact details are public and registrations cannot be refunded.</p>}
      {tld === 'io' && <p className="notice">.io follows its registry's rules, requires at least two nameservers, and registrations cannot be refunded. Read the registry addendum before buying.</p>}
      {(tld === 'dev' || tld === 'app') && <p className="notice">.{tld} requires HTTPS. Your website needs a TLS certificate before browsers can open it.</p>}
      {loading && <p className="checkout-status" role="status">Checking price and checkout details…</p>}
      {(loadError || expired || (live && account && !loading && !docsReady)) && <div className="checkout-status" role="alert"><p>{loadError ?? (expired ? 'This quote expired. Refresh it to see the current price.' : 'The required terms could not be loaded. Checkout is paused until they are available.')}</p><button className="link-btn" type="button" onClick={() => setRevision(v => v + 1)}>Refresh checkout</button></div>}
      {live && account && hasContact === false && <ContactForm email={account.user.email} onSaved={() => setHasContact(true)} />}
      {live && account && hasContact && authorisation && <details><summary>Auto-renew (optional)</summary><p className="fineprint">Save your payment method to renew at the renewal price in effect. Confirm with your passkey after registration; turn it off from your account. <a href={authorisation.url} target="_blank" rel="noreferrer">Read the authorization</a>.</p><label className="check"><input type="checkbox" checked={autoRenew} disabled={busy} onChange={e => setAutoRenew(e.target.checked)} />Save my card for auto-renew.</label></details>}
      {live && account && hasContact && docsReady && <label className="check"><input type="checkbox" checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)} /><span>I accept the <a href={doc('terms')!.url} target="_blank" rel="noreferrer">terms of service</a>, <a href={doc('registration_agreement')!.url} target="_blank" rel="noreferrer">registration agreement</a>{addendum && <> and <a href={addendum.url} target="_blank" rel="noreferrer">.{tld} registry terms</a></>}.</span></label>}
      <details><summary>Your domain, your control</summary><p className="fineprint">Manage DNS, renewals and eligible transfers from your account. Registration is handled through our registrar partner. No extras are preselected. <a href="/how-it-works" target="_blank" rel="noreferrer">How ownership works</a> · <a href="/report.html" target="_blank" rel="noreferrer">Get help</a></p></details>
      {error && <p role="alert" className="notice">{error} Retrying the same request will reuse your checkout attempt.</p>}
      <div className="checkout-actions">
        {!live && <button type="button" className="btn primary" onClick={() => { if (handle.world) void runHatch(r.domain); else setError('Your domain preview is shown above. The animated hatch needs a browser with WebGL; purchasing does not.'); }}>Preview creature</button>}
        {live && account && <button type="button" className="btn primary" disabled={busy || !accepted || !docsReady || !quoteReady || !hasContact} onClick={() => void pay()}>{busy ? 'Opening secure checkout…' : `Buy domain & hatch${total ? ` · ${total}` : ''}`}</button>}
        {live && !account && <button type="button" className="btn primary" onClick={() => set({ accountOpen: true })}>Continue with this domain</button>}
        <button type="button" className="text-btn" disabled={busy} onClick={() => set({ hatchPhase: 'none', selected: null })}>Keep exploring</button>
      </div>
    </div>
  </aside>;
}
