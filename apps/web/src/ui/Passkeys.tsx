import { useState } from "react";
import { addPasskey, explain, removePasskey, type Me } from "../lib/account";
import type { StepUpType } from "../lib/domains";
import { StepUp, type StepUpRequest } from "./StepUp";

const added = (iso?: string) => (iso ? new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" }) : "");

/**
 * The passkeys of the signed-in account: the list, Add a passkey (the current passkey confirms the change, then the browser makes the new one
 * from a click of its own, so every browser allows it), and Remove (the last one only with recovery codes left, and only once confirmed).
 */
export default function Passkeys({ account, onChanged, say }: { account: Me; onChanged: () => Promise<void>; say: (m: string | null) => void }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [needConfirm, setNeedConfirm] = useState(false);
  const [confirmLast, setConfirmLast] = useState(false);
  const begin = (e: React.FormEvent) => {
    e.preventDefault(); say(null);
    setReq({ type: "passkey.add" as StepUpType, target: account.user.id, input: { label: label.trim() || "Passkey" }, explain, run: async (id) => { setReady(id); } });
  };
  const create = async () => {
    if (!ready) return;
    setBusy(true); say(null);
    try { await addPasskey(ready); setReady(null); setAdding(false); setLabel(""); await onChanged(); say("Passkey added. Secret reveals are on hold for 24 hours, as they are after any passkey change."); }
    catch (e) { say(explain(e)); }
    finally { setBusy(false); }
  };
  const remove = async (c: Me["credentials"][number]) => {
    setBusy(true); say(null);
    try { await removePasskey(c.id, confirmLast); setConfirmLast(false); setNeedConfirm(false); await onChanged(); say(`Removed the passkey ${c.label}.`); }
    catch (e) { if ((e as { code?: string }).code === "confirm_required") setNeedConfirm(true); say(explain(e)); }
    finally { setBusy(false); }
  };
  return (
    <>
      <ul className="plain passkeys">
        {account.credentials.map((c) => (
          <li key={c.id}>
            <span><strong>{c.label}</strong>{c.createdAt ? `, added ${added(c.createdAt)}` : ""}{c.suspended ? ", paused by the recovery" : ""}{c.backupEligible === false ? ", on one device only" : ""}</span>
            <button type="button" className="btn secondary small" disabled={busy || !!c.suspended} aria-label={`Remove the passkey ${c.label}`} onClick={() => void remove(c)}>Remove</button>
          </li>
        ))}
      </ul>
      {needConfirm && (
        <label className="check"><input type="checkbox" checked={confirmLast} onChange={(e) => setConfirmLast(e.target.checked)} /> <span>Remove my last passkey. My recovery codes become the only way back in.</span></label>
      )}
      {!adding ? (
        <div className="row-actions"><button type="button" className="btn secondary" disabled={busy} onClick={() => { say(null); setAdding(true); }}>Add a passkey</button></div>
      ) : ready ? (
        <div className="row-actions">
          <button type="button" className="btn primary" disabled={busy} onClick={() => void create()}>Create the new passkey</button>
          <button type="button" className="btn secondary" disabled={busy} onClick={() => { setReady(null); setAdding(false); }}>Cancel</button>
        </div>
      ) : (
        <form className="form-grid" aria-label="Add a passkey" onSubmit={begin}>
          <label htmlFor="pk-label">A name for it, like Phone or Work laptop</label>
          <input id="pk-label" className="text-input" maxLength={64} value={label} onChange={(e) => setLabel(e.target.value)} autoComplete="off" />
          <p className="fineprint">Your current passkey confirms the change first. Then the browser makes the new one, on this device or on another you choose, such as a phone.</p>
          <div className="row-actions">
            <button type="submit" className="btn primary" disabled={busy || !!req}>Continue</button>
            <button type="button" className="btn secondary" onClick={() => { setAdding(false); setReq(null); }}>Cancel</button>
          </div>
        </form>
      )}
      {req && <StepUp req={req} onDone={() => setReq(null)} />}
    </>
  );
}
