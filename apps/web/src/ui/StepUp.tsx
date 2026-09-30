import { useEffect, useRef, useState } from "react";
import { commitStepUp, explainDomain, prepareStepUp, type Prepared, type StepUpType } from "../lib/domains";

export interface StepUpRequest {
  type: StepUpType; target: string; input?: unknown;
  /** Runs the one gated request with the committed action id. Errors it throws are shown here in plain words. */
  run: (actionId: string) => Promise<void>;
}

/**
 * Step-up for a gated action. Two clicks on purpose: the server first says in words what will be signed, then the person presses
 * the button that opens the passkey prompt (browsers want a fresh click for that). Holds no secret; the prepared challenge lives in state only.
 */
export function StepUp({ req, onDone }: { req: StepUpRequest; onDone: () => void }) {
  const [prepared, setPrepared] = useState<Prepared | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let live = true;
    prepareStepUp(req.type, req.target, req.input).then((p) => { if (live) setPrepared(p); }).catch((e) => { if (live) setMsg(explainDomain(e)); });
    return () => { live = false; };
  }, [req]);
  useEffect(() => { head.current?.focus(); }, []);
  const approve = async () => {
    if (!prepared) return;
    setBusy(true); setMsg(null);
    try { const id = await commitStepUp(prepared); await req.run(id); onDone(); }
    catch (e) { setMsg(explainDomain(e)); setPrepared(null); }
    finally { setBusy(false); }
  };
  return (
    <div className="stepup" role="group" aria-labelledby="stepup-h">
      <h3 id="stepup-h" ref={head} tabIndex={-1}>Confirm with your passkey</h3>
      {!prepared && !msg && <p role="status">Preparing.</p>}
      {prepared && <p>{prepared.summary}</p>}
      {msg && <p role="alert" className="notice">{msg}</p>}
      <div className="row-actions">
        {prepared && <button type="button" className="btn primary" disabled={busy} onClick={() => void approve()}>Approve with passkey</button>}
        <button type="button" className="btn secondary" disabled={busy} onClick={onDone}>{msg && !prepared ? "Close" : "Cancel"}</button>
      </div>
    </div>
  );
}
