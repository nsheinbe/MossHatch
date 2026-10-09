import { useState } from "react";
import { addPasskey, explain, type Me } from "../lib/account";
import { StepUp, type StepUpRequest } from "./StepUp";
import { useAccountAction } from "./useAccountAction";

/** Add through the existing exact-change step-up. Owner credentials never go to agents. */
export default function Passkeys({ account, onChanged }: { account: Me; onChanged: () => Promise<void> }) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState("");
  const [request, setRequest] = useState<StepUpRequest | null>(null);
  const [approved, setApproved] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { busy, run, invalidate } = useAccountAction(setMessage, explain);
  const cancel = () => { invalidate(); setAdding(false); setRequest(null); setApproved(null); setLabel(""); };
  const create = () => run(async (active) => {
    if (!approved) return;
    await addPasskey(approved, active);
    if (!active()) return;
    setApproved(null); setAdding(false); setLabel("");
    await onChanged();
    if (active()) setMessage("Passkey added. Other browser sessions were signed out. Secret reveals are on hold for 24 hours.");
  });
  return <section aria-labelledby="account-passkeys">
    <h3 id="account-passkeys">Passkeys</h3>
    <p>Use your phone, computer or security key. Your device asks for its PIN or biometrics; MossHatch never receives them.</p>
    <p className="fineprint">This is passwordless sign-in. A passkey can combine possession with device verification; it is not a separate password plus one-time-code setup. Sensitive changes still ask you to verify with your passkey again.</p>
    <ul className="plain">{account.credentials.map((key) => <li key={key.id}>
      <strong>{key.label}</strong>{key.suspended ? " — paused by account recovery" : key.backupEligible ? " — can sync through your passkey provider" : " — stays on one device"}
    </li>)}</ul>
    <p className="notice">Keep a second passkey on a different device or security key, and save recovery codes somewhere safe. Never give your passkeys, recovery codes or device PIN to an agent.</p>
    {message && <p role="status" className="notice">{message}</p>}
    {!adding ? <button type="button" className="btn secondary" onClick={() => setAdding(true)}>Add a passkey</button> : approved ? <div className="row-actions">
      <button type="button" className="btn primary" disabled={busy} onClick={() => void create()}>Create the new passkey</button>
      <button type="button" className="btn secondary" disabled={busy} onClick={cancel}>Cancel</button>
    </div> : <form onSubmit={(event) => {
      event.preventDefault();
      if (request || busy) return;
      setRequest({ type: "passkey.add", target: account.user.id, input: { label: label.trim() || "Passkey" }, explain, run: async (id) => { setApproved(id); } });
    }}>
      <label htmlFor="passkey-label">Name for the new passkey</label>
      <input id="passkey-label" className="text-input" maxLength={64} autoComplete="off" disabled={!!request} value={label} onChange={(event) => setLabel(event.target.value)} />
      <p className="fineprint">Confirm with your current passkey first, then choose where to create the new one.</p>
      <div className="row-actions">
        <button type="submit" className="btn primary" disabled={!!request}>Continue</button>
        <button type="button" className="btn secondary" onClick={cancel}>Cancel adding a passkey</button>
      </div>
    </form>}
    {request && <StepUp req={request} onDone={() => setRequest(null)} />}
  </section>;
}
