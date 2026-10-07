import { useEffect, useState } from "react";
import { useUi, type Result } from "../store";
import { ApiError } from "../lib/api";
import { explain } from "../lib/account";
import { forgetCheckout, getOrder, pendingCheckout, startCheckout, type OrderView } from "../lib/orders";
import { JourneySteps } from "./JourneySteps";

/**
 * An unfinished checkout, offered back (docs/AUDIT-2026-10-07.md D4, D5). Reached from Stripe's back link (/checkout/cancelled), from
 * Back, or from a reload while a checkout this tab started is still open. Resuming replays the same request under the same idempotency
 * key, so the server hands back the same order and the same Stripe Checkout (or a fresh one for that order if it expired); it never
 * creates a second order. Nothing here charges anything.
 */
export function CheckoutResume() {
  const { resume, account, accountOpen, set } = useUi();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!resume) return;
    let active = true;
    setOrder(null); setProblem(null);
    void getOrder(resume.orderId).then((o) => {
      if (!active) return;
      // Paid or further along: the order panel tells that story, with its live status.
      if (o.state !== "checkout_open") { if (o.state !== "checkout_expired" && o.state !== "payment_failed") { set({ resume: null, orderId: o.id }); return; } forgetCheckout(); }
      setOrder(o);
    }).catch((e) => {
      if (!active) return;
      if (e instanceof ApiError && e.status === 404) { forgetCheckout(); set({ resume: null }); return; }
      setProblem(e instanceof ApiError && e.status === 401 ? "Sign in with the account you used to see this order." : explain(e));
    });
    return () => { active = false; };
  }, [resume, account, set]);
  if (!resume || accountOpen) return null;
  const close = () => { set({ resume: null }); if (location.pathname !== "/") history.replaceState(null, "", "/"); };
  const reopen = (fqdn: string, years: number) => {
    const tld = fqdn.slice(fqdn.indexOf(".") + 1);
    const r: Result = { domain: fqdn, tld, available: true, sample: false, years };
    set({ resume: null, selected: r, hatchPhase: "sheet", query: fqdn.slice(0, fqdn.indexOf(".")) });
    if (location.pathname !== "/") history.replaceState(null, "", "/");
  };
  const back = async () => {
    if (!order) return;
    const p = pendingCheckout();
    // Without the original request in this tab (another tab, storage off), the sheet opens for the same name instead.
    if (!p || p.orderId !== order.id) { reopen(order.fqdn, order.years); return; }
    setBusy(true); setProblem(null);
    try {
      const o = await startCheckout(p.fqdn, p.years, p.accept, p.autoRenew, p.key);
      if (o.checkout_url) { window.location.assign(o.checkout_url); return; }
      forgetCheckout(); reopen(order.fqdn, order.years);
    } catch (e) { setProblem(explain(e)); setBusy(false); }
  };
  const open = order?.state === "checkout_open";
  return (
    <aside className="panel side order-panel" role="region" aria-label="Unfinished checkout" aria-live="polite">
      <div className="head"><h2>{order?.fqdn ?? "Your checkout"}</h2></div>
      <div className="body">
        {order && open && <JourneySteps at="pay" />}
        {!order && !problem && <p>Checking your checkout…</p>}
        {order && open && <p>{resume.reason === "cancelled" ? "You left secure checkout." : "You have an unfinished checkout."} Nothing was charged, and the name isn't held for you yet, so someone else could still register it.</p>}
        {order && !open && <p>That checkout ended before payment. Nothing was charged.</p>}
        {problem && <p role="alert" className="notice">{problem}</p>}
        <div className="row-actions">
          {order && open && <button className="btn primary" disabled={busy} onClick={() => void back()}>{busy ? "Opening secure checkout…" : "Return to secure checkout"}</button>}
          {order && !open && <button className="btn primary" onClick={() => reopen(order.fqdn, order.years)}>Check {order.fqdn} again</button>}
          {problem && !account && <button className="btn secondary" onClick={() => set({ accountOpen: true })}>Sign in</button>}
          <button className="text-btn" onClick={() => { forgetCheckout(); close(); }}>Choose a different name</button>
        </div>
      </div>
    </aside>
  );
}
