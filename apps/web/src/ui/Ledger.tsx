import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { day, explainDomain, getLedger, money, refundOrder, type LedgerEntry, type LedgerRefund } from "../lib/domains";

const KIND: Record<string, string> = { register: "Registration", renew: "Renewal", transfer_in: "Transfer in", restore: "Restore" };
function status(e: LedgerEntry): string {
  if (e.refunded_minor !== "0" && e.charged_minor !== null) return e.refunded_minor === e.charged_minor ? "Refunded in full" : "Partly refunded";
  switch (e.state) {
    case "captured": case "renewed": return "Paid";
    case "refunded": return "Refunded in full";
    case "voided": case "canceling": case "checkout_expired": case "registration_failed": case "payment_failed": return "Cancelled. You were not charged.";
    case "checkout_open": case "draft": return "Waiting for payment";
    default: return "In progress";
  }
}

/** Every order, payment, refund and renewal, oldest last. The price shown is the price charged. Lazy chunk. */
export default function Ledger() {
  const { set } = useUi();
  const [data, setData] = useState<{ entries: LedgerEntry[]; refunds: LedgerRefund[] } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const load = () => getLedger().then(setData).catch((e) => setMsg(explainDomain(e)));
  useEffect(() => { void load(); head.current?.focus(); }, []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape") set({ view: "grove" }); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [set]);

  const refund = async (id: string) => {
    setMsg(null);
    try { await refundOrder(id); setConfirm(null); setMsg("Refund started. It shows here once the card is credited."); await load(); }
    catch (e) { setMsg(explainDomain(e)); setConfirm(null); }
  };

  return (
    <main>
      <div className="panel ledger" role="region" aria-labelledby="ledger-h">
        <div className="head"><h2 id="ledger-h" ref={head} tabIndex={-1}>Ledger</h2></div>
        <div className="body">
          <p className="notice">Every charge, refund and renewal on your account. Amounts are in US dollars and include any tax.</p>
          {msg && <p role="status" className="notice">{msg}</p>}
          {!data && !msg && <p role="status">Loading.</p>}
          {data && data.entries.length === 0 && <p>Nothing here yet. Your orders show up after you buy a name.</p>}
          {data && data.entries.length > 0 && (
            <div className="table-wrap">
              <table className="data">
                <caption className="sr-only">Orders and payments</caption>
                <thead><tr><th scope="col">Date</th><th scope="col">What</th><th scope="col">Name</th><th scope="col">Status</th><th scope="col">Charged</th><th scope="col">Refunded</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                <tbody>
                  {data.entries.map((e) => (
                    <tr key={e.order_id}>
                      <td>{day(e.captured_at ?? e.created_at)}</td>
                      <td>{KIND[e.kind] ?? "Order"}, {e.years} {e.years === 1 ? "year" : "years"}</td>
                      <td>{e.fqdn}</td>
                      <td>{status(e)}</td>
                      <td>{e.charged_minor === null ? "Not charged" : money(e.charged_minor)}</td>
                      <td>{e.refunded_minor === "0" ? "" : money(e.refunded_minor)}</td>
                      <td>
                        {e.state === "captured" && e.refunded_minor === "0" && confirm !== e.order_id && <button type="button" className="btn secondary small" aria-label={`Ask for a refund of ${e.fqdn}`} onClick={() => setConfirm(e.order_id)}>Refund</button>}
                        {confirm === e.order_id && (
                          <span role="group" aria-label={`Confirm the refund of ${e.fqdn}`}>
                            <span className="notice">A refund can delete the name. </span>
                            <button type="button" className="btn primary small" onClick={() => void refund(e.order_id)}>Refund and delete</button>{" "}
                            <button type="button" className="btn secondary small" onClick={() => setConfirm(null)}>Keep it</button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {data && data.refunds.length > 0 && (
            <>
              <h3>Refunds</h3>
              <ul className="plain">{data.refunds.map((r) => <li key={r.id}>{day(r.created_at)}: {money(r.amount_minor)} refunded to your card.</li>)}</ul>
            </>
          )}
        </div>
      </div>
    </main>
  );
}
