import { useState } from "react";
import { explain, recoveryCancel, recoveryPasskey, recoveryRedeem, recoveryStart, type RecoveryBanner, type RecoveryPath } from "../lib/account";
import { useAccountAction } from "./useAccountAction";

const when = (iso: string | null) => iso ? new Date(iso).toLocaleString() : "the displayed hold ends";

export function RecoverAccount({ initialEmail, onBack, onRecovered }: { initialEmail: string; onBack: () => void; onRecovered: () => Promise<void> }) {
  const [phase, setPhase] = useState<"start" | "codes" | "passkey">("start");
  const [email, setEmail] = useState(initialEmail);
  const [path, setPath] = useState<RecoveryPath>("codes_email");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const { busy, run, invalidate } = useAccountAction(setMessage, explain);
  return <aside className="panel side" role="region" aria-label="Recover your account">
    <div className="head"><h2>Recover your account</h2></div>
    <div className="body">
      {phase === "start" ? <form onSubmit={(event) => { event.preventDefault(); void run(async (active) => {
        await recoveryStart(email, path);
        if (active()) setPhase("codes");
      }); }}>
        <p>Lost every passkey? Recovery lets you create a new one. We notify every email address on your account. Signing in with an existing passkey before recovery finishes cancels it.</p>
        <label htmlFor="recovery-email">Your account email</label>
        <input id="recovery-email" type="email" autoComplete="email" className="text-input" required disabled={busy} value={email} onChange={(e) => setEmail(e.target.value)} />
        <fieldset disabled={busy}>
          <legend>Choose a recovery method</legend>
          <label className="check"><input type="radio" name="recovery-path" checked={path === "codes_email"} onChange={() => setPath("codes_email")} /> A saved recovery code plus an emailed code</label>
          <p className="fineprint">Create a new passkey straight away. Sensitive actions stay on hold for 24 hours.</p>
          <label className="check"><input type="radio" name="recovery-path" checked={path === "email_only"} onChange={() => setPath("email_only")} /> Email only</label>
          <p className="fineprint">Requires a second verified address on a different mail domain. Wait 72 hours before receiving a code, then sensitive actions stay on hold for another 72 hours.</p>
        </fieldset>
        <button type="submit" className="btn primary" disabled={busy}>Start recovery</button>
      </form> : phase === "codes" ? <form onSubmit={(event) => { event.preventDefault(); void run(async (active) => {
        await recoveryRedeem(email, code.trim(), path === "codes_email" ? recoveryCode.trim() : undefined);
        setCode(""); setRecoveryCode("");
        if (active()) setPhase("passkey");
      }); }}>
        <p>{path === "codes_email" ? "If that address has an account, an eight-digit code is on its way. It lasts 24 hours. Each saved recovery code works once." : "If recovery is available, the 72-hour wait has started. Come back after the wait and start email recovery again to receive your code. If you already waited, it is on its way."}</p>
        <label htmlFor="recovery-email-code">Eight-digit code from the email</label>
        <input id="recovery-email-code" className="text-input" inputMode="numeric" autoComplete="one-time-code" required disabled={busy} maxLength={16} value={code} onChange={(e) => setCode(e.target.value)} />
        {path === "codes_email" && <>
          <label htmlFor="recovery-saved-code">One saved recovery code</label>
          <input id="recovery-saved-code" className="text-input" autoComplete="off" autoCapitalize="characters" spellCheck={false} required disabled={busy} maxLength={64} value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} />
        </>}
        <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}>Verify recovery codes</button></div>
      </form> : <>
        <p>Your codes were accepted. Create a new passkey within 30 minutes. If you close its prompt, try this button again; your codes have already been used.</p>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void run(async (active) => {
          await recoveryPasskey(active);
          if (active()) await onRecovered();
        })}>Create replacement passkey</button>
      </>}
      {message && <p role="alert" className="notice">{message}</p>}
      <div className="row-actions"><button type="button" className="btn secondary" onClick={() => { invalidate(); setCode(""); setRecoveryCode(""); onBack(); }}>Back to sign in</button></div>
    </div>
  </aside>;
}

export function RecoveryNotice({ recovery, onChanged }: { recovery: RecoveryBanner; onChanged: () => Promise<void> }) {
  const [message, setMessage] = useState<string | null>(null);
  const { busy, run } = useAccountAction(setMessage, explain);
  return <section className="notice" aria-label="Account recovery" role="status">
    {recovery.status === "holding" ? <>
      <h3>Your account was recovered</h3>
      <p>Sensitive changes, passkey changes and secret reveals stay on hold until {when(recovery.holdUntil)}. Old passkeys are paused for 30 days; signing in with one undoes this recovery and revokes the recovery's sessions and agent grants.</p>
    </> : <>
      <h3>An account recovery is open</h3>
      <p>It started {when(recovery.startedAt)}. If you did not request this, cancel it.</p>
      <button type="button" className="btn secondary" disabled={busy} onClick={() => void run(async (active) => {
        await recoveryCancel(); if (active()) await onChanged();
      })}>Cancel account recovery</button>
    </>}
    {message && <p role="alert">{message}</p>}
  </section>;
}
