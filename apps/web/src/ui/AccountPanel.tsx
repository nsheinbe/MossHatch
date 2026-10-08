import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { explain, revokeAll, signIn, signOut, signupStart, signupVerify, whoAmI } from "../lib/account";
import { RecoverAccount, RecoveryNotice } from "./Recovery";
import { currentInvite, openWaitlist } from "../lib/waitlist";
import { buildSiteMode } from "../lib/site";
import { sayWaiting } from "../lib/waiting";
import { openWaiting } from "./Waiting";

type Step = "choose" | "code" | "codes" | "recover";

/** Show a recovery code in groups of five so it is easier to read and copy out by hand. The server ignores spaces. */
const groupCode = (c: string) => c.match(/.{1,5}/g)?.join(" ") ?? c;
const codesText = (codes: string[]) =>
  `Mosshatch recovery codes\nCreated ${new Date().toISOString().slice(0, 10)}. Each code works once. Keep them somewhere safe.\n\n${codes.map(groupCode).join("\n")}\n`;

async function copyCodes(codes: string[]): Promise<boolean> {
  try { await navigator.clipboard.writeText(codes.map(groupCode).join("\n")); return true; } catch { return false; }
}

function downloadCodes(codes: string[]): void {
  const url = URL.createObjectURL(new Blob([codesText(codes)], { type: "text/plain" }));
  const a = Object.assign(document.createElement("a"), { href: url, download: "mosshatch-recovery-codes.txt" });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
// Download my data and Close my account: a lazy chunk (closure module routes), loaded only when asked for.
const AccountData = lazy(() => import("./AccountData"));

// Passkeys: a lazy chunk too (the step-up module stays out of the first load).
const Passkeys = lazy(() => import("./Passkeys"));

/** Sign-up (emailed code, then a passkey), passkey sign-in, recovery, and the account view. No passwords anywhere. */
export function AccountPanel() {
  const { accountOpen, account, accountNotice, waiting, set } = useUi();
  const [step, setStep] = useState<Step>("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [data, setData] = useState<"export" | "close" | null>(null);
  // Invite-only rollout: without an invite, sign-up shows the waitlist instead (the server answers 403 invite_required).
  const [needInvite, setNeedInvite] = useState(() => (import.meta.env.VITE_INVITE_ONLY === "1" || buildSiteMode === "invite") && !currentInvite());
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (accountOpen) head.current?.focus(); }, [accountOpen, step]);
  useEffect(() => {
    if (!accountOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") set({ accountOpen: false, accountNotice: null }); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [accountOpen, set]);
  if (!accountOpen) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true); setMsg(null);
    try { await fn(); }
    catch (e) { if ((e as { code?: string }).code === "invite_required") { setNeedInvite(true); setStep("choose"); openWaitlist({ email, source: "signup" }); } else setMsg(explain(e)); }
    finally { setBusy(false); }
  };
  const refresh = async () => set({ account: await whoAmI() });

  if (account) {
    const live = account.credentials.filter((c) => !c.suspended).length;
    const paused = account.credentials.length - live;
    return (
      <aside className="panel side" role="region" aria-label="Your account">
        <div className="head"><h2 ref={head} tabIndex={-1}>Your account</h2></div>
        <div className="body">
          {account.recovery && <RecoveryNotice recovery={account.recovery} onCancelled={async (m) => { await refresh(); setMsg(m); }} />}
          <p>Signed in as <strong>{account.user.email}</strong>.</p>
          {msg && <p role="alert" className="notice">{msg}</p>}
          {data ? (
            <Suspense fallback={<p role="status">Loading.</p>}><AccountData mode={data} userId={account.user.id} onDone={() => setData(null)} onClosed={(m) => { setData(null); setMsg(m); set({ account: null }); }} /></Suspense>
          ) : (
            <>
              <section className="section" aria-labelledby="pk-h">
                <h3 id="pk-h">Passkeys</h3>
                <p className="notice">{live} {live === 1 ? "passkey" : "passkeys"}{paused ? `, and ${paused} paused by the recovery` : ""}. {live < 2 ? "Add a second one so losing a device does not lock you out." : "You can sign in from any of them."}</p>
                <Suspense fallback={<p role="status">Loading.</p>}><Passkeys account={account} onChanged={refresh} say={setMsg} /></Suspense>
              </section>
              <section className="section" aria-labelledby="apps-h">
                <h3 id="apps-h">Apps and assistants</h3>
                {waiting.length > 0 && (
                  <div className="banner" role="status">
                    <p><strong>{waiting.length === 1 ? "Waiting for your decision." : `${waiting.length} requests are waiting for your decision.`}</strong> {sayWaiting(waiting[0]!)}</p>
                    <div className="row-actions"><button type="button" className="btn primary" onClick={() => openWaiting(waiting[0]!)}>Review</button></div>
                  </div>
                )}
                <p className="notice">Connect Claude or another assistant, and manage the tokens and apps that act for you.</p>
                <div className="row-actions"><button type="button" className="btn secondary" onClick={() => set({ visitorsOpen: true, accountOpen: false })}>Connected apps</button></div>
              </section>
              <section className="section" aria-labelledby="data-h">
                <h3 id="data-h">Your data</h3>
                <p className="notice">A copy of everything we hold about you, or the way out. Both need your passkey.</p>
                <div className="row-actions">
                  <button type="button" className="btn secondary" onClick={() => setData("export")}>Download my data</button>
                  <button type="button" className="btn secondary" onClick={() => setData("close")}>Close my account</button>
                </div>
              </section>
              <section className="section" aria-labelledby="sess-h">
                <h3 id="sess-h">Signed in</h3>
                <p className="notice">Sign out here, or everywhere: that ends every session of this account, on every device and browser, and revokes nothing else.</p>
                <div className="row-actions">
                  <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => { await signOut(); set({ account: null, accountOpen: false }); })}>Sign out</button>
                  <button type="button" className="btn secondary" disabled={busy} onClick={() => run(async () => { await revokeAll(); set({ account: null, accountOpen: false }); })}>Sign out everywhere</button>
                </div>
              </section>
            </>
          )}
          <div className="row-actions"><button type="button" className="btn secondary" onClick={() => set({ accountOpen: false, accountNotice: null })}>Close</button></div>
        </div>
      </aside>
    );
  }

  if (step === "recover") {
    // A finished recovery signs in: the account view below takes over and shows the hold.
    return <RecoverAccount initialEmail={email} onBack={() => { setMsg(null); setStep("choose"); }} onClose={() => set({ accountOpen: false, accountNotice: null })}
      onRecovered={async () => { await refresh(); setStep("choose"); }} />;
  }

  if (step === "codes") {
    return (
      <aside className="panel side" role="region" aria-label="Your recovery codes">
        <div className="head"><h2 ref={head} tabIndex={-1}>Save your recovery codes</h2></div>
        <div className="body">
          <p>If you ever lose every passkey, one of these codes and a code we email you will get you back in. Each code works once. We only show them now, so copy them into a password manager or download the file.</p>
          <ul className="codes">{codes.map((c) => <li key={c}><code>{groupCode(c)}</code></li>)}</ul>
          <div className="row-actions">
            <button type="button" className="btn secondary" onClick={() => void copyCodes(codes).then((ok) => setMsg(ok ? "Copied all ten codes." : "Could not copy. Select the codes and copy them by hand, or download the file."))}>Copy all</button>
            <button type="button" className="btn secondary" onClick={() => { downloadCodes(codes); setMsg("Downloaded mosshatch-recovery-codes.txt."); }}>Download .txt</button>
          </div>
          {msg && <p role="status" className="notice">{msg}</p>}
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={() => { setCodes([]); setMsg(null); setStep("choose"); void refresh().then(() => set({ accountOpen: false, accountNotice: null })); }}>I saved them</button>
          </div>
        </div>
      </aside>
    );
  }

  return (
    <aside className="panel side" role="region" aria-label="Sign in or create an account">
      <div className="head"><h2 ref={head} tabIndex={-1}>{step === "code" ? "Check your email" : "Sign in"}</h2></div>
      <div className="body">
        {step === "choose" && (
          <>
            {accountNotice && <p role="status" className="notice">{accountNotice}</p>}
            <p>Sign in with a passkey. There are no passwords.</p>
            <div className="row-actions">
              {/* The recovery banner is shown at every sign-in, so the panel stays open while there is one. */}
              <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => { await signIn(); const me = await whoAmI(); set({ account: me, accountOpen: !!me?.recovery, accountNotice: null }); })}>Sign in with a passkey</button>
            </div>
            <p><button type="button" className="linklike lost-passkey" onClick={() => { setMsg(null); setStep("recover"); }}>Lost your passkey?</button></p>
            <hr className="rule" />
            {needInvite ? (
              <div role="group" aria-label="Invite only">
                <p>Mosshatch is letting people in a few at a time. New accounts need an invite: join the waitlist and we will email you one when it is your turn.</p>
                <div className="row-actions"><button type="button" className="btn secondary" onClick={() => openWaitlist({ email, source: "signup" })}>Join the waitlist</button></div>
              </div>
            ) : (
            <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await signupStart(email); setStep("code"); }); }}>
              <label htmlFor="acct-email">New here? Your email</label>
              <input id="acct-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="text-input" />
              <div className="row-actions"><button type="submit" className="btn secondary" disabled={busy}>Email me a code</button></div>
            </form>
            )}
          </>
        )}
        {step === "code" && (
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await signupVerify(email, code.trim()); setCodes(r.recoveryCodes); setStep("codes"); }); }}>
            <p>If that address can be used, a code is on its way. It lasts fifteen minutes. If it is not in your inbox within a minute, look in Junk: our mail is new to most providers.</p>
            <label htmlFor="acct-code">Eight-digit code</label>
            <input id="acct-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className="text-input" />
            <div className="row-actions">
              <button type="submit" className="btn primary" disabled={busy}>Create my passkey</button>
              <button type="button" className="btn secondary" onClick={() => setStep("choose")}>Back</button>
            </div>
          </form>
        )}
        {msg && <p role="alert" className="notice" style={{ marginTop: 10 }}>{msg}</p>}
        <div className="row-actions"><button type="button" className="btn secondary" onClick={() => set({ accountOpen: false, accountNotice: null })}>Close</button></div>
      </div>
    </aside>
  );
}
