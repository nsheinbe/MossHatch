import { useEffect, useRef, useState } from "react";
import { useUi, type Result } from "../store";
import { getContact, getDocuments, rememberCheckout, startCheckout, type LegalDoc } from "../lib/orders";
import { liveQuote, type LiveQuote } from "../lib/find";
import { ContactForm } from "./ContactForm";
import { explain } from "../lib/account";
import { runHatch } from "./hatchFlow";
import { PracticeHatchNotice } from "./DemoNotice";
import { OwnershipPreview } from "./OwnershipPreview";
import { JourneySteps } from "./JourneySteps";
import { supportHref } from "./OrderReturn";
import { handle } from "../world/handle";
import { trackConversion, attribution } from "../lib/conversion";

export function HatchSheet() {
  const { selected, hatchPhase, account } = useUi();
  if (hatchPhase !== "sheet" || !selected) return null;
  // A selection/account change starts a clean quote and consent state. Late responses cannot price another domain.
  return <CheckoutSheet key={`${selected.domain}:${account?.user.id ?? 'guest'}`} r={selected} />;
}

const at = (d: Date) => d.toLocaleString(undefined, { month: "long", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" });
const clock = (iso: string) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? null : d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }); };
const termWords = (years: number) => (years === 1 ? "year" : `${years} years`);

/** What a public registration lookup shows, per extension (D-020; the .ai and .io addenda). Never stronger than what is verified. */
function privacyRow(tld: string): string {
  if (tld === "ai") return "Public: the .ai registry publishes your contact details";
  if (tld === "io") return "No privacy service: the .io registry's rules decide what is public";
  return "Personal details redacted in public lookups where the registry allows";
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
  // Back from Stripe can restore this page from the back-forward cache with the button still "Opening secure checkout…": release it.
  useEffect(() => { const show = (e: PageTransitionEvent) => { if (e.persisted) { inFlight.current = false; setBusy(false); } }; window.addEventListener("pageshow", show); return () => window.removeEventListener("pageshow", show); }, []);
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
  const salesOpen = !live || !quote || quote.salesOpen;
  const total = live ? quote?.subtotal : r.price;
  const term = years === 2 && tld === "ai" ? "First 2 years (minimum)" : years === 1 ? "First year" : `First ${years} years`;
  const renewsOn = new Date(Date.now() + years * 365.25 * 86_400_000);
  const refundBy = quote?.refund.refundable ? new Date(Date.now() + quote.refund.windowDays * 86_400_000) : null;
  const checked = quote ? clock(quote.quotedAt) : null;
  const pay = async () => {
    if (inFlight.current || !quoteReady || !accepted || !docsReady || !hasContact || !salesOpen) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const accept: Record<string,string> = { terms: doc('terms')!.version, registration_agreement: doc('registration_agreement')!.version };
      if (addendum) accept[addendum.kind] = addendum.version;
      const renew = autoRenew && !!authorisation;
      if (renew) accept.auto_renew_authorisation = authorisation!.version;
      const signature = JSON.stringify([r.domain, years, accept, renew]);
      if (attempt.current?.signature !== signature) attempt.current = { signature, key: crypto.randomUUID() };
      trackConversion('checkout', false);
      const o = await startCheckout(r.domain, years, accept, renew, attempt.current.key);
      // Attribution cannot block or duplicate checkout. Only coarse campaign/device labels are sent.
      void attribution(o.order_id);
      if (!o.checkout_url) {
        // The order exists but its Checkout can no longer be opened (it expired, or it was already paid): start a fresh attempt.
        attempt.current = null;
        throw new Error("checkout_closed");
      }
      // Kept in this tab only, so Back, Stripe's back link or a reload can resume this same checkout instead of starting another.
      rememberCheckout({ orderId: o.order_id, fqdn: r.domain, years, accept, autoRenew: renew, key: attempt.current.key });
      window.location.assign(o.checkout_url);
    } catch (e) {
      setError((e as Error).message === "checkout_closed" ? "That checkout can't be reopened. Press the button again to start a fresh one; nothing was charged." : `${explain(e)} Retrying the same request will reuse your checkout attempt.`);
      setBusy(false); inFlight.current = false;
    }
  };
  return <aside className="panel side checkout-sheet" role="region" aria-label={`Hatch ${r.domain}`} hidden={accountOpen}>
    <div className="head"><h2 ref={head} tabIndex={-1}>{r.domain}</h2></div>
    <div className="body">
      {live && <JourneySteps at="choose" />}
      <PracticeHatchNotice domain={r.domain} />
      <p className="notice">{live ? 'Review the price and terms, then pay on Stripe. Your card is only held until our registrar confirms the name is yours; then it is charged and your creature hatches.' : 'Preview only. A practice hatch does not purchase or reserve this name.'}</p>
      {live && quote && !quote.salesOpen && <div className="checkout-status" role="alert"><p><strong>New registrations are paused right now.</strong> Nothing can be charged, and the name isn't held. Please check back later.</p></div>}
      <dl className="rows">
        <dt>{term}</dt><dd>{total ?? (loading ? 'Checking…' : 'Unavailable')}</dd>
        <dt>Renews at</dt><dd>{live ? (quote ? `${quote.subtotal} / ${termWords(years)}` : 'Checking…') : `${r.renewal ?? r.price ?? 'At launch'} / ${termWords(years)}`}</dd>
        {live && quote && <><dt>Renewal date</dt><dd>About {renewsOn.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })}</dd></>}
        <dt>Public lookups</dt><dd>{privacyRow(tld)}</dd>
        <dt className="total">{live ? 'Total today, before tax' : 'Published test price'}</dt><dd className="total">{total ?? 'Unavailable'}</dd>
      </dl>
      <p className="fineprint">{live
        ? <>Sales tax, if any, is added by Stripe from your billing address before you pay. Renewal prices follow our registrar's price; if it changes we email you at once and again 21 days before any charge. {checked && `Price checked at ${checked}. We check again when you pay. `}<a href="/fees" target="_blank" rel="noreferrer">Fees, renewals and notices</a></>
        : 'Invite-only test pricing. Public launch prices may change.'}</p>
      {live && quote && <details><summary>How the price is made</summary><dl className="rows">
        <dt>Our registrar's price for this term</dt><dd>{quote.registrarNow}</dd>
        {quote.renewalLevel && <><dt>Renewal level</dt><dd>{quote.renewalLevel}</dd></>}
        <dt>MossHatch fee</dt><dd>{quote.fee}</dd>
        <dt className="total">Total before tax</dt><dd className="total">{quote.subtotal}</dd>
      </dl>{quote.renewalLevel && <p className="fineprint">Our registrar charges more to renew this name than to register it, so we charge the renewal level from the first year. Your price is then the same every year at today's registrar prices, with no jump at the first renewal.</p>}</details>}
      {live && quote && <dl className="rows rows-small">
        <dt>Refunds</dt><dd>{refundBy ? `Until ${at(refundBy)}, if the name has no DNS records or connections yet. A refund deletes the name.` : 'Not refundable once registered'}</dd>
        {quote.registrar && <><dt>Registrar of record</dt><dd>{quote.registrar.name} (IANA ID {quote.registrar.ianaId}). Mosshatch is a reseller. <a href="/legal/registrant-rights" target="_blank" rel="noreferrer">Your rights</a></dd></>}
      </dl>}
      {tld === 'ai' && <p className="notice">.ai is sold in 2-year terms. Registrant contact details are public and registrations cannot be refunded.</p>}
      {tld === 'io' && <p className="notice">.io follows its registry's rules, has no privacy service, requires at least two nameservers, and registrations cannot be refunded. The United Kingdom and Mauritius have a treaty about the .io territory that is not in force; read the registry addendum before buying.</p>}
      {(tld === 'dev' || tld === 'app') && <p className="notice">.{tld} names work only over HTTPS. Your website needs a TLS certificate before browsers can open it.</p>}
      {loading && <p className="checkout-status" role="status">Checking price and checkout details…</p>}
      {(loadError || expired || (live && account && !loading && !docsReady)) && <div className="checkout-status" role="alert"><p>{loadError ?? (expired ? 'This quote expired. Refresh it to see the current price.' : 'The required terms could not be loaded. Checkout is paused until they are available.')}</p><button className="link-btn" type="button" onClick={() => setRevision(v => v + 1)}>Refresh checkout</button></div>}
      {live && account && hasContact === false && <ContactForm email={account.user.email} onSaved={() => setHasContact(true)} />}
      {live && account && hasContact && authorisation && quote && <div className="auto-renew-choice">
        <label className="check"><input type="checkbox" checked={autoRenew} disabled={busy} onChange={e => setAutoRenew(e.target.checked)} /><span>Save my card for auto-renew (optional)</span></label>
        <p className="fineprint">If you tick this, Stripe saves your card. Auto-renew stays off until you confirm it with your passkey on the domain page after registration. Once on, we charge the renewal price ten days before the name expires, never more than {quote.subtotal} for {years === 1 ? "one year" : `${years} years`} without your passkey, and we email you first. Turn it off any time with one click. <a href={authorisation.url} target="_blank" rel="noreferrer">Read the authorisation</a>.</p>
      </div>}
      {live && account && hasContact && docsReady && <label className="check"><input type="checkbox" checked={accepted} disabled={busy} onChange={e => setAccepted(e.target.checked)} /><span>I accept the <a href={doc('terms')!.url} target="_blank" rel="noreferrer">terms of service</a>, <a href={doc('registration_agreement')!.url} target="_blank" rel="noreferrer">registration agreement</a>{addendum && <> and <a href={addendum.url} target="_blank" rel="noreferrer">.{tld} registry terms</a></>}.</span></label>}
      {live && <p className="fineprint">No add-ons. Nothing is pre-checked.</p>}
      <OwnershipPreview domain={r.domain} />
      {live && <p className="fineprint">Questions before you buy? <a href={supportHref()}>Email support</a> · <a href="/how-it-works" target="_blank" rel="noreferrer">How ownership works</a></p>}
      {error && <p role="alert" className="notice">{error}</p>}
      <div className="checkout-actions">
        {!live && <button type="button" className="btn primary" onClick={() => { if (handle.world) void runHatch(r.domain); else setError('Your domain preview is shown above. The animated hatch needs a browser with WebGL; purchasing does not.'); }}>Preview creature</button>}
        {live && account && <button type="button" className="btn primary" disabled={busy || !accepted || !docsReady || !quoteReady || !hasContact || !salesOpen} onClick={() => void pay()}>{busy ? 'Opening secure checkout…' : `Buy domain & hatch${total ? ` · ${total}` : ''}`}</button>}
        {live && !account && <button type="button" className="btn primary" onClick={() => set({ accountOpen: true })}>Continue with this domain</button>}
        <button type="button" className="text-btn" disabled={busy} onClick={() => set({ hatchPhase: 'none', selected: null })}>Keep exploring</button>
      </div>
    </div>
  </aside>;
}
