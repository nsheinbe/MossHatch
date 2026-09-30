import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { explainDomain, issueTransferCode, lockDomain, unlockDomain } from "../lib/domains";
import { StepUp, type StepUpRequest } from "./StepUp";

/**
 * Unlock, transfer code and re-lock for one name. The code is shown once. It lives only in this component's state: not in the store,
 * not in storage, not in the URL. It is cleared when the re-hide timer ends, when the tab is hidden, and when this component goes away.
 */
export function TransferCode({ fqdn, locked, onChanged }: { fqdn: string; locked: boolean; onChanged: () => void }) {
  const rehide = useUi((s) => s.rehideSeconds);
  const [code, setCode] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [hidden, setHidden] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useRef<HTMLElement>(null);

  const clear = () => { setCode(null); setLeft(0); setHidden(true); };
  useEffect(() => {
    if (code === null) return;
    shown.current?.focus();
    const t = window.setInterval(() => setLeft((n) => { if (n <= 1) { window.clearInterval(t); setCode(null); setHidden(true); return 0; } return n - 1; }), 1000);
    const vis = () => { if (document.hidden) clear(); };
    document.addEventListener("visibilitychange", vis);
    return () => { window.clearInterval(t); document.removeEventListener("visibilitychange", vis); };
  }, [code]);
  // A change of name or a reload of the panel drops the code with the component.
  useEffect(() => () => { setCode(null); }, []);

  const start = (type: "domain.unlock" | "domain.transfer_out") => {
    setMsg(null); setHidden(false);
    setReq({
      type, target: fqdn,
      run: async (id) => {
        if (type === "domain.unlock") { await unlockDomain(fqdn, id); setMsg("Unlocked. The name can now be transferred."); onChanged(); return; }
        const out = await issueTransferCode(fqdn, id);
        if (out.code) { setCode(out.code); setLeft(rehide); } else setMsg(out.message ?? "We asked our registrar for the code.");
      },
    });
  };
  const relock = async () => {
    setBusy(true); setMsg(null);
    try { await lockDomain(fqdn); clear(); setHidden(false); setMsg("Locked again. Any code that was shown is now replaced."); onChanged(); }
    catch (e) { setMsg(explainDomain(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="section" role="group" aria-labelledby="tc-h">
      <h3 id="tc-h">Transfer to another registrar</h3>
      {locked
        ? <p>The name is locked, so it cannot be transferred. To move it, unlock it with your passkey, then ask for a transfer code.</p>
        : <p>The name is unlocked. Lock it again when you are done.</p>}
      {code !== null && (
        <div className="code-box" role="group" aria-label="Transfer code">
          <p>Your transfer code. It is shown once and hides in {left} {left === 1 ? "second" : "seconds"}.</p>
          <p><code ref={shown} tabIndex={-1} className="xfer-code">{code}</code></p>
          <div className="row-actions"><button type="button" className="btn secondary" onClick={clear}>Hide it now</button></div>
        </div>
      )}
      {hidden && code === null && <p role="status" className="notice">The code is hidden. We cannot show it again. It is replaced after 24 hours. Ask for a new one if you still need it.</p>}
      {msg && <p role="status" className="notice">{msg}</p>}
      {req ? <StepUp key={req.type} req={req} onDone={() => setReq(null)} /> : (
        <div className="row-actions">
          {locked && <button type="button" className="btn secondary" onClick={() => start("domain.unlock")}>Unlock for transfer</button>}
          {!locked && <button type="button" className="btn secondary" onClick={() => start("domain.transfer_out")}>Get a transfer code</button>}
          {!locked && <button type="button" className="btn secondary" disabled={busy} onClick={() => void relock()}>Lock it again</button>}
        </div>
      )}
    </div>
  );
}
