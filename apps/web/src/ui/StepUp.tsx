import { useEffect, useRef, useState } from "react";
import { commitStepUp, explainDomain, prepareStepUp, type Prepared, type StepUpType } from "../lib/domains";

export interface StepUpRequest {
  type: StepUpType; target: string; input?: unknown;
  /** Runs the one gated request with the committed action id. Errors it throws are shown here in plain words. */
  run: (actionId: string) => Promise<void>;
  /** Plain words for this action's own error codes (prepare and run); the shared domain wording otherwise. */
  explain?: (e: unknown) => string;
}

/**
 * Step-up for a gated action. Two clicks on purpose: the server first says in words what will be signed, then the person presses
 * the button that opens the passkey prompt (browsers want a fresh click for that). Holds no secret; the prepared challenge lives in state only.
 * A prepared action belongs to the one request it was prepared for: when the caller hands in a new request (another record, another
 * code), the old summary and its Approve button go at once, and the gated request always runs with the request that was signed.
 * A failed or expired challenge offers Try again with a new one, so nobody has to finish inside the window (WCAG 2.2.1).
 */
export function StepUp({ req, onDone }: { req: StepUpRequest; onDone: () => void }) {
  const [prepared, setPrepared] = useState<{ req: StepUpRequest; p: Prepared } | null>(null);
  const [msg, setMsg] = useState<{ req: StepUpRequest; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const head = useRef<HTMLHeadingElement>(null);
  const say = (r: StepUpRequest, e: unknown) => setMsg({ req: r, text: (r.explain ?? explainDomain)(e) });
  useEffect(() => {
    let live = true;
    setPrepared(null); setMsg(null);
    prepareStepUp(req.type, req.target, req.input).then((p) => { if (live) setPrepared({ req, p }); })
      .catch((e) => { if (live) setMsg({ req, text: (req.explain ?? explainDomain)(e) }); });
    return () => { live = false; };
  }, [req, attempt]);
  useEffect(() => { head.current?.focus(); }, []);
  // Only what was prepared for the request in hand counts, even for the one render before the effect above runs.
  const current = prepared?.req === req ? prepared : null;
  const text = msg?.req === req ? msg.text : null;
  const approve = async () => {
    const cur = current;
    if (!cur) return;
    setBusy(true); setMsg(null);
    try { const id = await commitStepUp(cur.p); await cur.req.run(id); onDone(); }
    catch (e) { say(cur.req, e); setPrepared(null); }
    finally { setBusy(false); }
  };
  const again = () => { setMsg(null); setAttempt((n) => n + 1); head.current?.focus(); };
  return (
    <div className="stepup" role="group" aria-labelledby="stepup-h">
      <h3 id="stepup-h" ref={head} tabIndex={-1}>Confirm with your passkey</h3>
      {!current && !text && <p role="status">Preparing.</p>}
      {current && <p>{current.p.summary}</p>}
      {text && <p role="alert" className="notice">{text}</p>}
      <div className="row-actions">
        {current && <button type="button" className="btn primary" disabled={busy} onClick={() => void approve()}>Approve with passkey</button>}
        {text && !current && !busy && <button type="button" className="btn primary" onClick={again}>Try again</button>}
        <button type="button" className="btn secondary" disabled={busy} onClick={onDone}>{text && !current ? "Close" : "Cancel"}</button>
      </div>
    </div>
  );
}
