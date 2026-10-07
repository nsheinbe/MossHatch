import { useEffect, useState } from "react";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { forgetCheckout, getOrder, journeyOf, orderStory, payLink, reconcileOrder, TERMINAL, type OrderView } from "../lib/orders";
import { listDomains } from "../lib/domains";
import { explain } from "../lib/account";
import { runHatch } from "./hatchFlow";
import { takeHandoff } from "../lib/handoff";
import { JourneySteps } from "./JourneySteps";

export const SUPPORT_EMAIL = "support@mosshatch.com";
/** A support link that names the order (an opaque id) so a reply needs no back-and-forth. Never the card, the contact or a token. */
export const supportHref = (orderId?: string) => `mailto:${SUPPORT_EMAIL}${orderId ? `?subject=${encodeURIComponent(`Order ${orderId}`)}` : ""}`;

export function OrderReturn() {
  const { orderId, orderSession, accountOpen, hatchPhase, set } = useUi();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [error, setError] = useState(false);
  const [revision, setRevision] = useState(0);
  const [managing, setManaging] = useState(false);
  const [paying, setPaying] = useState<string | null>(null);
  useEffect(() => {
    if (!orderId) return;
    let active = true, timer = 0, hatchTimer = 0, failures = 0, hatched = false;
    setOrder(null); setError(false);
    const tick = async (first: boolean) => {
      try {
        const o = first && orderSession ? await reconcileOrder(orderId, orderSession) : await getOrder(orderId);
        if (!active) return;
        setOrder(o); setError(false); failures = 0;
        if (o.state !== "checkout_open") forgetCheckout();               // the checkout was finished (or ended): nothing to resume
        if (o.kind === "transfer_in") { set({ orderId: null, orderSession: null, rescue: { fqdn: o.fqdn, transferId: takeHandoff(o.id), orderId: o.id } }); history.replaceState(null, "", "/"); return; }
        const registered = o.kind !== "renew" && ["registered", "capturing", "captured"].includes(o.state);
        if (registered && !hatched && handle.world) { hatched = true; handle.world.setResults([{ domain: o.fqdn, available: true }]); hatchTimer = window.setTimeout(() => { if (active) void runHatch(o.fqdn); }, 1600); }
        if (!TERMINAL.has(o.state)) timer = window.setTimeout(() => void tick(false), 2000);
      } catch { if (!active) return; setError(true); if (++failures <= 3) timer = window.setTimeout(() => void tick(false), Math.min(15000, 2000 * 2 ** failures)); }
    };
    void tick(true);
    return () => { active = false; window.clearTimeout(timer); window.clearTimeout(hatchTimer); };
  }, [orderId, orderSession, revision, set]);
  if (!orderId || accountOpen) return null;
  // The creature's card is the moment of the purchase: while it is on screen the search steps aside and this panel docks on the other
  // side as a short receipt, so the card and the order never cover each other (docs/AUDIT-2026-10-07.md C1).
  const docked = hatchPhase === "hatching" || hatchPhase === "card";
  const dismiss = () => { set({ orderId: null, orderSession: null }); history.replaceState(null, "", "/"); };
  const manage = async () => {
    setManaging(true);
    try { const all = await listDomains(); const d = all.domains.find((d) => d.fqdn === order?.fqdn); if (d) { set({ domainPanel: { id: d.id, fqdn: d.fqdn }, hatchPhase: "none", card: null }); dismiss(); } else { setError(true); } } catch { setError(true); } finally { setManaging(false); }
  };
  const finishPaying = async () => {
    if (!order) return;
    setPaying("Opening secure checkout…");
    try { const { checkout_url } = await payLink(order.id); window.location.assign(checkout_url); }
    catch (e) { setPaying(explain(e)); }
  };
  const registered = order && order.kind !== "renew" && ["registered", "capturing", "captured"].includes(order.state);
  const journey = order && order.kind !== "renew" && order.kind !== "transfer_in" ? journeyOf(order.state) : null;
  return (
    <aside className={`panel side order-panel${docked ? " docked" : ""}`} role="region" aria-label="Your order" aria-live="polite">
      <div className="head"><h2>{order?.fqdn ?? "Your order"}</h2></div>
      <div className="body">
        {journey && <JourneySteps at={journey.at} stopped={journey.stopped} />}
        <p className="order-story">{order ? (order.message ?? orderStory(order)) : "Checking your order…"}</p>
        {error && <div role="alert"><p>We couldn't refresh your order. This does not mean registration failed. Sign in with the account you used, then check again.</p><button className="btn secondary" onClick={() => setRevision((x) => x + 1)}>Check order again</button><button className="text-btn" onClick={() => set({ accountOpen: true })}>Sign in</button></div>}
        {order?.charged_minor && <p className="notice">Charged {(Number(order.charged_minor) / 100).toFixed(2)} USD, tax included.</p>}
        {order?.state === "capture_failed" && order.pay_by && <div className="checkout-status"><button className="btn primary" disabled={paying === "Opening secure checkout…"} onClick={() => void finishPaying()}>Finish paying on Stripe</button>{paying && <p role="status" className="fineprint">{paying}</p>}</div>}
        {registered && !docked && <div className="checkout-status"><p>Your name is registered. Next: confirm your contact email, connect a website, and choose how it renews. The domain page walks you through it.</p><button className="btn primary" disabled={managing} onClick={() => void manage()}>{managing ? "Opening…" : "Set up my domain"}</button></div>}
        <div className="row-actions">{!docked && <button className="btn secondary" onClick={dismiss}>Close</button>}<a href={supportHref(order?.id)}>Email support</a></div>
      </div>
    </aside>
  );
}
