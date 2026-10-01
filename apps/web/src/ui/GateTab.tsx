import { useCallback, useEffect, useState } from "react";
import { explainDomain, stopTransfer, type DomainDetail } from "../lib/domains";
import { day, explainTransfer, getGate, type GateView } from "../lib/transfers";
import { TransferCode } from "./TransferCode";

const STATE_LINE: Record<GateView["state"], string> = {
  locked: "Locked. The name cannot be transferred away.",
  unlocked: "Unlocked. The name can be transferred once a code is given out.",
  code_issued: "A transfer code is out. Whoever holds it can start a transfer at another registrar.",
  code_requested: "A transfer code was asked for. Our registrar's support team sets codes for this extension.",
  blocked: "The name cannot move to another registrar yet.",
  traveling: "A transfer to another registrar is under way. You asked for it.",
  needs_attention: "A transfer to another registrar is under way, and you did not ask for it.",
  left: "The name has left Mosshatch.",
};

/**
 * The Gate: whether the name can leave, why not (the 60-day rules with the day they lift), the transfer code, and a transfer away
 * that is under way with Stop. Unlock and the code sit behind the passkey (TransferCode). Lazy chunk; nothing is stored.
 */
export default function GateTab({ d, reloadAll }: { d: DomainDetail; reloadAll: () => void }) {
  const [g, setG] = useState<GateView | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    try { setG(await getGate(d.id)); setErr(null); } catch (e) { setErr(explainTransfer(e)); }
  }, [d.id]);
  useEffect(() => { setG(null); void load(); }, [load]);
  const changed = () => { void load(); reloadAll(); };
  const stop = async () => {
    setBusy(true); setMsg(null);
    try { await stopTransfer(d.fqdn); setMsg("Stopped. The name is locked again and its code was replaced. Our team has been told."); changed(); }
    catch (e) { setMsg(explainDomain(e)); }
    finally { setBusy(false); }
  };

  if (err) return <p role="alert" className="notice">{err}</p>;
  if (!g) return <p role="status">Loading.</p>;
  const p = g.pending;
  return (
    <div className="gate">
      {p && (
        <div className={p.requested_by_you ? "section" : "banner"} role="group" aria-labelledby="gate-away-h">
          <h3 id="gate-away-h">{p.requested_by_you ? "Transfer away in progress" : "A transfer you did not ask for"}</h3>
          <p>{p.gaining_registrar ? `${p.gaining_registrar} asked for this name` : "Another registrar asked for this name"}{p.requested_at ? ` on ${day(p.requested_at)}` : ""}. {p.stopped ? "It is stopped and waiting for our team." : `Unless it is declined, it goes through on ${day(p.decline_by)}.`}</p>
          <p>{g.approval}</p>
          {!p.stopped && p.stop_available && (
            <div className="row-actions"><button type="button" className="btn primary" disabled={busy} onClick={() => void stop()}>Stop this transfer</button></div>
          )}
          <p className="notice">{g.cancel}</p>
        </div>
      )}
      {msg && <p role="status" className="notice">{msg}</p>}

      <p>{STATE_LINE[g.state]}</p>
      <dl className="rows facts">
        <div><dt>Transfer lock</dt><dd>{g.locked ? "On" : "Off"}</dd></div>
        <div><dt>Transfer code</dt><dd>{g.code.outstanding ? `Given out${g.code.replace_at ? `, replaced ${day(g.code.replace_at)}` : ""}` : "None given out"}</dd></div>
        <div><dt>Can move away</dt><dd>{g.released ? "It has left" : g.transferable ? "Yes, once unlocked" : g.transferable_from ? `From ${day(g.transferable_from)}` : "Not yet"}</dd></div>
      </dl>

      {g.blocks.length > 0 && (
        <div className="section" role="group" aria-labelledby="gate-blocks-h">
          <h3 id="gate-blocks-h">Why it cannot move yet</h3>
          <ul className="plain">
            {g.blocks.map((b) => <li key={b.code}>{b.message}{b.until ? ` This lifts on ${day(b.until)}.` : ""}</li>)}
          </ul>
        </div>
      )}
      {g.code.request && <p className="notice">{g.code.request.message}{g.code.request.due_at ? ` Due by ${day(g.code.request.due_at)}.` : ""}</p>}
      {g.billing_blocks_transfer === false && <p className="notice">An unpaid bill or a payment dispute never stops you from taking your name elsewhere.</p>}

      {!g.released && <TransferCode fqdn={d.fqdn} locked={g.locked} onChanged={changed} />}

      <div className="section" role="group" aria-labelledby="gate-steps-h">
        <h3 id="gate-steps-h">How a transfer away works</h3>
        <ol className="gate-steps">{g.steps.map((s) => <li key={s}>{s}</li>)}</ol>
        <p className="notice">{g.timing}</p>
      </div>
    </div>
  );
}
