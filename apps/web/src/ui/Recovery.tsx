import { useEffect, useRef, useState } from "react";
import { ApiError } from "../lib/api";
import { explain, recoveryCancel, recoveryPasskey, recoveryRedeem, recoveryStart, type RecoveryBanner, type RecoveryPath } from "../lib/account";

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "");
// Every action marked held in PLAN 4.5 (HELD_ACTIONS on the server), plus the passkey, recovery-code and address changes a hold freezes.
const HELD = [
  "transfer a name away or unlock it, or change its nameservers or contact",
  "show secrets, publish a card, or approve agent purchases or sensitive DNS changes",
  "create or widen agent tokens, or approve a sign-in from a device",
  "add or remove passkeys, make new recovery codes, or change your email addresses",
  "close the account or download its data",
];

/** Text for a failed recovery step. The server never says which of the two codes was wrong, so neither does this. */
function explainRecovery(e: unknown, path: RecoveryPath, redeemed: boolean): string {
  if (e instanceof ApiError && e.code === "invalid_code") {
    return path === "codes_email"
      ? "That did not work. Check the code from the email and the recovery code. Each recovery code works once."
      : "That code did not work. Check it. If the 72-hour wait is not over yet, there is no code to enter.";
  }
  if (redeemed && (e as { name?: string } | null)?.name === "NotAllowedError") return "The passkey prompt was closed or timed out. Your codes are already accepted, so just try the passkey again.";
  return explain(e);
}

/**
 * "Lost your passkey?": the two recovery paths of D-016. Asks for the account email and the path, starts the request, takes the
 * emailed code (and a saved recovery code on `codes_email`), then creates a new passkey, which completes the recovery and signs in.
 */
export function RecoverAccount({ initialEmail, onBack, onClose, onRecovered }: { initialEmail: string; onBack: () => void; onClose: () => void; onRecovered: () => Promise<void> }) {
  const [phase, setPhase] = useState<"start" | "code">("start");
  const [email, setEmail] = useState(initialEmail);
  const [path, setPath] = useState<RecoveryPath>("codes_email");
  const [code, setCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  // The codes were accepted and spent: the browser holds a 30-minute registration ticket, so a retry needs only the passkey.
  const [redeemed, setRedeemed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, [phase]);

  const restart = (m: string) => { setRedeemed(false); setCode(""); setRecoveryCode(""); setPhase("start"); setMsg(m); };
  const submitStart = async () => {
    setBusy(true); setMsg(null);
    try { await recoveryStart(email, path); setCode(""); setRecoveryCode(""); setRedeemed(false); setPhase("code"); }
    catch (e) { setMsg(explain(e)); }
    finally { setBusy(false); }
  };
  const submitCode = async () => {
    setBusy(true); setMsg(null);
    let spent = redeemed;
    try {
      if (!spent) {
        const options = await recoveryRedeem(email, code.trim(), path === "codes_email" ? recoveryCode.trim() : undefined);
        spent = true; setRedeemed(true);
        await recoveryPasskey(options);
      } else {
        await recoveryPasskey();
      }
      await onRecovered();
    } catch (e) {
      const c = e instanceof ApiError ? e.code : "";
      // The ticket ran out (30 minutes) or the request was cancelled meanwhile: the codes are spent, so it starts again.
      if (spent && (c === "unauthorized" || c === "recovery_not_open")) restart(c === "unauthorized" ? "The 30 minutes to add a passkey are over. Start the recovery again." : explain(e));
      else setMsg(explainRecovery(e, path, spent));
    } finally { setBusy(false); }
  };

  return (
    <aside className="panel side" role="region" aria-label="Recover your account">
      <div className="head"><h2 ref={head} tabIndex={-1}>{phase === "start" ? "Recover your account" : redeemed ? "Add your new passkey" : "Check your email"}</h2></div>
      <div className="body">
        {phase === "start" && (
          <form onSubmit={(e) => { e.preventDefault(); void submitStart(); }}>
            <p>Lost every passkey? You can add a new one. Either way, we tell every email address on the account, and signing in with a passkey before you finish cancels the recovery.</p>
            <label htmlFor="rec-email">Your account email</label>
            <input id="rec-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="text-input" />
            <fieldset className="rec-paths">
              <legend>How will you prove it is you?</legend>
              <label className="rec-radio"><input type="radio" name="rec-path" value="codes_email" checked={path === "codes_email"} onChange={() => setPath("codes_email")} aria-describedby="rec-codes-help" /> With a recovery code</label>
              <p id="rec-codes-help" className="notice">Use one of the ten codes you saved when you signed up, plus a code we email you now. You add a new passkey straight away. After that, sensitive actions such as transferring a name or showing secrets are on hold for 24 hours.</p>
              <label className="rec-radio"><input type="radio" name="rec-path" value="email_only" checked={path === "email_only"} onChange={() => setPath("email_only")} aria-describedby="rec-email-help" /> With email only</label>
              <p id="rec-email-help" className="notice">For when you have no recovery code. It works only if your account has a second verified email address on a different mail domain. First there is a 72-hour wait, then we email you a code. After you add a new passkey, sensitive actions are on hold for another 72 hours.</p>
            </fieldset>
            <div className="row-actions">
              <button type="submit" className="btn primary" disabled={busy}>{path === "codes_email" ? "Email me a code" : "Continue"}</button>
              <button type="button" className="btn secondary" onClick={onBack}>Back to sign in</button>
            </div>
          </form>
        )}
        {phase === "code" && (
          <form onSubmit={(e) => { e.preventDefault(); void submitCode(); }}>
            {redeemed ? (
              <p>Your codes were accepted. Add the new passkey within 30 minutes.</p>
            ) : path === "codes_email" ? (
              <>
                <p>If that address has an account, we emailed it an eight-digit code. It works for 24 hours.</p>
                <label htmlFor="rec-code">Eight-digit code from the email</label>
                <input id="rec-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className="text-input" />
                <label htmlFor="rec-rcode" className="rec-field">One of your recovery codes</label>
                <input id="rec-rcode" autoComplete="off" autoCapitalize="characters" spellCheck={false} required value={recoveryCode} onChange={(e) => setRecoveryCode(e.target.value)} className="text-input" aria-describedby="rec-rcode-help" />
                <p id="rec-rcode-help" className="notice rec-help">26 letters and numbers, from the list you saved when you signed up.</p>
              </>
            ) : (
              <>
                <p>If recovery can start for that address, the 72-hour wait is running now. We emailed every address on the account so its owner can stop it.</p>
                <p>When the wait is over, come back, choose “Lost your passkey?” and “With email only” again, and we will email you an eight-digit code. If you have already waited, the code is on its way now.</p>
                <label htmlFor="rec-code">Eight-digit code from the email</label>
                <input id="rec-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className="text-input" />
              </>
            )}
            <div className="row-actions">
              <button type="submit" className="btn primary" disabled={busy}>{redeemed ? "Try the passkey again" : "Add a new passkey"}</button>
              {!redeemed && <button type="button" className="btn secondary" onClick={() => { setMsg(null); setPhase("start"); }}>Back</button>}
            </div>
          </form>
        )}
        {msg && <p role="alert" className="notice" style={{ marginTop: 10 }}>{msg}</p>}
        <div className="row-actions"><button type="button" className="btn secondary" onClick={onClose}>Close</button></div>
      </div>
    </aside>
  );
}

/**
 * The recovery banner from /me, shown in the account panel at every sign-in while a request is open or its hold runs.
 * An open request can be cancelled from here: whoever is signed in already holds a passkey, so the recovery is not needed.
 */
export function RecoveryNotice({ recovery, onCancelled }: { recovery: RecoveryBanner; onCancelled: (message: string) => Promise<void> }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  if (recovery.status === "holding") {
    return (
      <div className="banner" role="status">
        <h3>Your account was recovered</h3>
        <p>A new passkey was added {recovery.path === "codes_email" ? "with a recovery code" : "by email"}. To keep the account safe, sensitive actions are on hold until <strong>{when(recovery.holdUntil)}</strong>.</p>
        <p>Until then you cannot:</p>
        <ul className="rec-held">{HELD.map((h) => <li key={h}>{h}</li>)}</ul>
        <p>Everything else works as usual.</p>
        <p>Your old passkeys are paused for 30 days. Signing in with one of them undoes this recovery.</p>
      </div>
    );
  }
  const cancel = async () => {
    setBusy(true); setMsg(null);
    try { await recoveryCancel(); await onCancelled("The recovery is cancelled. Nothing about your passkeys changed."); }
    catch (e) { setMsg(explain(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="banner" role="alert">
      <h3>Someone started a recovery of this account</h3>
      {recovery.status === "cooling_off" ? (
        <p>It started {when(recovery.startedAt)}, by email only. When the wait ends, {when(recovery.coolingOffUntil)}, whoever started it can ask for a code and add a new passkey.</p>
      ) : (
        <p>It started {when(recovery.startedAt)}, with a recovery code. Whoever has one of your recovery codes and the code we emailed can add a new passkey now.</p>
      )}
      <p>If this was not you, cancel it. If it was you, you are signed in already, so you do not need it.</p>
      {msg && <p className="notice">{msg}</p>}
      <button type="button" className="btn primary" disabled={busy} onClick={() => void cancel()}>Cancel the recovery</button>
    </div>
  );
}
