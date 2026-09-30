import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { getOrder, orderStory, reconcileOrder, TERMINAL, type OrderView } from "../lib/orders";
import { runHatch } from "./hatchFlow";
import { takeHandoff } from "../lib/handoff";

/**
 * Where Stripe sends the person back to (`?order=<id>`). It asks the server to reconcile (the same idempotent call the webhook uses),
 * shows the honest state, and only when the name is registered does the egg rise and hatch. The creature is an egg until then.
 */
export function OrderReturn() {
  const { orderId, orderSession, set } = useUi();
  const [order, setOrder] = useState<OrderView | null>(null);
  const [gone, setGone] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!orderId) return;
    let alive = true;
    let timer = 0;
    const tick = async (first: boolean) => {
      try {
        const o = first && orderSession ? await reconcileOrder(orderId, orderSession) : await getOrder(orderId);
        if (!alive) return;
        setOrder(o);
        // A transfer in is followed in the Rescue panel, which says Traveling until the server reports the transfer completed.
        if (o.kind === "transfer_in") { set({ orderId: null, orderSession: null, rescue: { fqdn: o.fqdn, transferId: takeHandoff(o.id), orderId: o.id } }); history.replaceState(null, "", "/"); return; }
        // A renewal paid on Checkout has no egg to hatch: the creature already lives in the grove.
        const renewal = o.kind === "renew";
        const done = !renewal && ["registered", "capturing", "captured"].includes(o.state);
        if (done && !started.current && handle.world) {
          started.current = true;
          handle.world.setResults([{ domain: o.fqdn, available: true }]);
          window.setTimeout(() => void runHatch(o.fqdn), 1600);
        }
        // Keep looking until the order is over, and until the scene has loaded far enough to hatch the name.
        if ((!TERMINAL.has(o.state) && !done) || (done && !started.current)) timer = window.setTimeout(() => void tick(false), 1500);
      } catch { if (alive) setGone(true); }
    };
    void tick(true);
    return () => { alive = false; window.clearTimeout(timer); };
  }, [orderId, orderSession]);

  if (!orderId) return null;
  const dismiss = () => { set({ orderId: null, orderSession: null }); history.replaceState(null, "", "/"); };
  return (
    <aside className="panel side" role="region" aria-label="Your order" aria-live="polite" style={{ top: "auto", bottom: 96 }}>
      <div className="head"><h2>{order?.fqdn ?? "Your order"}</h2></div>
      <div className="body">
        <p>{gone ? "We could not find that order. Sign in with the account that placed it." : order ? (order.message ?? orderStory(order.state)) : "Checking your order."}</p>
        {order && order.charged_minor && <p className="notice">Charged {(Number(order.charged_minor) / 100).toFixed(2)} USD, tax included.</p>}
        <div className="row-actions"><button type="button" className="btn secondary" onClick={dismiss}>Close</button></div>
      </div>
    </aside>
  );
}
