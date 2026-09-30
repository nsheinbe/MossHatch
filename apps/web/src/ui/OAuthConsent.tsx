import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import type { StepUpType } from "../lib/domains";
import { approveConsent, denyConsent, explainVisitor, getConsent, when, type Consent } from "../lib/visitors";
import { StepUp, type StepUpRequest } from "./StepUp";

const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

/**
 * The OAuth consent screen for MCP connectors (D-019). Reached from the authorization endpoint with `?oauth_request=<id>`; the
 * first signed-in person to open it claims it. It shows what the server checked (where the grant goes back to, how the app
 * identified itself) apart from what the app says about itself, and nothing is granted without your passkey. Lazy chunk.
 */
export default function OAuthConsent({ id, onClose }: { id: string; onClose: () => void }) {
  const { account, apiReady, set } = useUi();
  const [c, setC] = useState<Consent | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [form, setForm] = useState({ name: "Connected app", scopes: "", days: "30", cap: "0" });
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  useEffect(() => {
    if (!account) return;
    getConsent(id).then((x) => { setC(x); setForm((f) => ({ ...f, name: x.defaults.name, days: String(x.defaults.expires_in_days), scopes: (x.suggested_scopes.length ? x.suggested_scopes : ["domains.read:*"]).join("\n") })); })
      .catch((e) => setMsg(explainVisitor(e)));
  }, [id, account]);

  const approve = (ev: React.FormEvent) => {
    ev.preventDefault();
    setMsg(null);
    const input = { name: form.name.trim(), scopes: lines(form.scopes), expires_in_days: Number(form.days), spend_cap_minor: Math.round(Number(form.cap || "0") * 100) };
    setReq({ type: "agent.token.create" as StepUpType, target: `oauth_${id}`, input, run: async (actionId) => { const r = await approveConsent(id, actionId); location.assign(r.redirect_to); } });
  };
  const deny = async () => { try { const r = await denyConsent(id); location.assign(r.redirect_to); } catch (e) { setMsg(explainVisitor(e)); } };

  return (
    <main>
      <div className="panel ledger consent" role="region" aria-labelledby="consent-h">
        <div className="head"><h2 id="consent-h" ref={head} tabIndex={-1}>Connect an app to your account</h2></div>
        <div className="body">
          {apiReady === false && <p className="notice">Accounts are not connected in this preview.</p>}
          {apiReady && !account && (
            <><p className="notice">Sign in first. Then this page shows what the app asks for.</p>
              <div className="row-actions"><button type="button" className="btn primary" onClick={() => set({ accountOpen: true })}>Sign in</button></div></>
          )}
          {msg && <p role="alert" className="notice">{msg}</p>}
          {c && (
            <>
              <p>Only continue if you started this from the app yourself, just now.</p>
              <h3>What we checked</h3>
              <dl className="facts">
                <div><dt>It sends you back to</dt><dd><strong>{c.redirect_host}</strong>{c.redirect_is_this_computer ? " (a program on this computer)" : ""}</dd></div>
                {c.client_id_host && <div><dt>Published by</dt><dd>{c.client_id_host}</dd></div>}
                <div><dt>This request expires</dt><dd>{when(c.expires_at)}</dd></div>
              </dl>
              <h3>Reported by the app, not verified</h3>
              <p>{c.reported.client_name ?? "No name given"}</p>
              {!req && (
                <form className="form-grid" onSubmit={approve}>
                  <label htmlFor="c-name">Name for this connection (you will see it on every request it makes)</label>
                  <input id="c-name" className="text-input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={64} />
                  <label htmlFor="c-scopes">What it can do, one scope per line</label>
                  <textarea id="c-scopes" className="text-input" rows={4} value={form.scopes} onChange={(e) => setForm({ ...form, scopes: e.target.value })} spellCheck={false} aria-describedby="c-scopes-hint" />
                  <p id="c-scopes-hint" className="fineprint">Your names: {c.domains.length ? c.domains.join(", ") : "none yet"}. For example <code>dns.read:example.com</code> or <code>register.propose:*</code>.{c.ignored_scopes ? ` ${c.ignored_scopes} scope${c.ignored_scopes === 1 ? "" : "s"} it asked for were not valid and are not offered.` : ""}</p>
                  <label htmlFor="c-cap">Spend cap in dollars, for purchases you approve</label>
                  <input id="c-cap" className="text-input" inputMode="decimal" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} />
                  <label htmlFor="c-days">Days until it expires (at most 90)</label>
                  <input id="c-days" className="text-input" inputMode="numeric" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })} />
                  <div className="row-actions">
                    <button type="submit" className="btn primary">Allow with passkey</button>
                    <button type="button" className="btn secondary" onClick={() => void deny()}>Deny</button>
                  </div>
                </form>
              )}
              {req && <StepUp req={req} onDone={() => setReq(null)} />}
            </>
          )}
          <div className="row-actions"><button type="button" className="btn secondary" onClick={onClose}>Close</button></div>
        </div>
      </div>
    </main>
  );
}
