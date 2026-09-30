import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { explain, revokeAll, signIn, signOut, signupStart, signupVerify, whoAmI } from "../lib/account";

type Step = "choose" | "code" | "codes";
// Download my data and Close my account: a lazy chunk (closure module routes), loaded only when asked for.
const AccountData = lazy(() => import("./AccountData"));

/** Sign-up (emailed code, then a passkey), passkey sign-in, and the small account view. No passwords anywhere. */
export function AccountPanel() {
  const { accountOpen, account, set } = useUi();
  const [step, setStep] = useState<Step>("choose");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [data, setData] = useState<"export" | "close" | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { if (accountOpen) head.current?.focus(); }, [accountOpen, step]);
  useEffect(() => {
    if (!accountOpen) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") set({ accountOpen: false }); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [accountOpen, set]);
  if (!accountOpen) return null;

  const run = async (fn: () => Promise<void>) => { setBusy(true); setMsg(null); try { await fn(); } catch (e) { setMsg(explain(e)); } finally { setBusy(false); } };
  const refresh = async () => set({ account: await whoAmI() });

  if (account) {
    return (
      <aside className="panel side" role="region" aria-label="Your account">
        <div className="head"><h2 ref={head} tabIndex={-1}>Your account</h2></div>
        <div className="body">
          <p>Signed in as <strong>{account.user.email}</strong>.</p>
          <p className="notice">{account.credentials.length} {account.credentials.length === 1 ? "passkey" : "passkeys"}. {account.credentials.length < 2 ? "Add a second one so losing a device does not lock you out." : ""}</p>
          {msg && <p role="alert" className="notice">{msg}</p>}
          {data && <Suspense fallback={<p role="status">Loading.</p>}><AccountData mode={data} userId={account.user.id} onDone={() => setData(null)} onClosed={(m) => { setData(null); setMsg(m); set({ account: null }); }} /></Suspense>}
          <div className="row-actions">
            <button type="button" className="btn secondary" onClick={() => set({ visitorsOpen: true, accountOpen: false })}>Visitors</button>
            <button type="button" className="btn secondary" aria-pressed={data === "export"} onClick={() => setData("export")}>Download my data</button>
            <button type="button" className="btn secondary" aria-pressed={data === "close"} onClick={() => setData("close")}>Close my account</button>
            <button type="button" className="btn secondary" disabled={busy} onClick={() => run(async () => { await revokeAll(); set({ account: null, accountOpen: false }); })}>Sign out everywhere</button>
            <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => { await signOut(); set({ account: null, accountOpen: false }); })}>Sign out</button>
            <button type="button" className="btn secondary" onClick={() => set({ accountOpen: false })}>Close</button>
          </div>
        </div>
      </aside>
    );
  }

  if (step === "codes") {
    return (
      <aside className="panel side" role="region" aria-label="Your recovery codes">
        <div className="head"><h2 ref={head} tabIndex={-1}>Save your recovery codes</h2></div>
        <div className="body">
          <p>These ten codes are the way back in if you lose every passkey. They are shown once.</p>
          <ul className="codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ul>
          <div className="row-actions">
            <button type="button" className="btn primary" onClick={() => { setCodes([]); setStep("choose"); void refresh().then(() => set({ accountOpen: false })); }}>I saved them</button>
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
            <p>Sign in with a passkey. There are no passwords.</p>
            <div className="row-actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => run(async () => { await signIn(); await refresh(); set({ accountOpen: false }); })}>Sign in with a passkey</button>
            </div>
            <hr className="rule" />
            <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await signupStart(email); setStep("code"); }); }}>
              <label htmlFor="acct-email">New here? Your email</label>
              <input id="acct-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} className="text-input" />
              <div className="row-actions"><button type="submit" className="btn secondary" disabled={busy}>Email me a code</button></div>
            </form>
          </>
        )}
        {step === "code" && (
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await signupVerify(email, code.trim()); setCodes(r.recoveryCodes); setStep("codes"); }); }}>
            <p>If that address can be used, a code is on its way. It lasts fifteen minutes.</p>
            <label htmlFor="acct-code">Eight-digit code</label>
            <input id="acct-code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} className="text-input" />
            <div className="row-actions">
              <button type="submit" className="btn primary" disabled={busy}>Create my passkey</button>
              <button type="button" className="btn secondary" onClick={() => setStep("choose")}>Back</button>
            </div>
          </form>
        )}
        {msg && <p role="alert" className="notice" style={{ marginTop: 10 }}>{msg}</p>}
        <div className="row-actions"><button type="button" className="btn secondary" onClick={() => set({ accountOpen: false })}>Close</button></div>
      </div>
    </aside>
  );
}
