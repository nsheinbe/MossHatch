import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import type { StepUpType } from "../lib/domains";
import { approveConsent, denyConsent, explainVisitor, getConsent, when, type Consent } from "../lib/visitors";
import { CHOICES, canSpend, describeScope, lines, minor, picksFrom, scopesFor } from "../lib/scopes";
import { StepUp, type StepUpRequest } from "./StepUp";

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
  const [form, setForm] = useState({ name: "Connected app", picks: ["see"] as string[], which: "*", extra: "", days: "90", cap: "" });
  // Advanced opens once, when the app asked for scopes the everyday choices do not cover; after that it is the person's to fold.
  const [askedExtra, setAskedExtra] = useState(false);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { head.current?.focus(); }, []);
  useEffect(() => {
    if (!account) return;
    // What the app asked for, mapped onto the everyday choices where it fits; the rest stays visible under Advanced, unticked by nobody.
    getConsent(id).then((x) => {
      setC(x);
      const asked = picksFrom(x.suggested_scopes);
      setAskedExtra(asked.rest.length > 0);
      setForm((f) => ({ ...f, name: x.defaults.name, days: String(x.defaults.expires_in_days), picks: asked.picks.length ? asked.picks : ["see"], which: asked.name !== "*" && x.domains.includes(asked.name) ? asked.name : "*", extra: asked.rest.join("\n") }));
    }).catch((e) => setMsg(explainVisitor(e)));
  }, [id, account]);

  const scopes = [...new Set([...scopesFor(form.picks, form.which), ...lines(form.extra)])];
  const spends = canSpend(scopes);
  const approve = (ev: React.FormEvent) => {
    ev.preventDefault();
    setMsg(null);
    if (!form.name.trim()) { setMsg("Give this connection a name, like Claude."); return; }
    if (scopes.length === 0) { setMsg("Pick at least one thing it can do."); return; }
    if (spends && !(minor(form.cap) > 0)) { setMsg("Set the most it can ask you to spend, in dollars. With nothing there it could not suggest anything."); return; }
    const input = { name: form.name.trim(), scopes, expires_in_days: Number(form.days), spend_cap_minor: spends ? minor(form.cap) : 0 };
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
                  <fieldset className="choices">
                    <legend>Which names</legend>
                    <label className="check"><input type="radio" name="c-which" checked={form.which === "*"} onChange={() => setForm({ ...form, which: "*" })} /> <span>All my names</span></label>
                    {c.domains.length > 0 && (
                      <label className="check"><input type="radio" name="c-which" checked={form.which !== "*"} onChange={() => setForm({ ...form, which: c.domains[0]! })} /> <span>Only one name</span></label>
                    )}
                    {form.which !== "*" && (
                      <label>The name
                        <select className="text-input" value={form.which} onChange={(e) => setForm({ ...form, which: e.target.value })}>{c.domains.map((n) => <option key={n} value={n}>{n}</option>)}</select>
                      </label>
                    )}
                  </fieldset>
                  <fieldset className="choices">
                    <legend>What it can do</legend>
                    {CHOICES.map((ch) => (
                      <label key={ch.id} className="check">
                        <input type="checkbox" checked={form.picks.includes(ch.id)} onChange={(e) => setForm({ ...form, picks: e.target.checked ? [...form.picks, ch.id] : form.picks.filter((x) => x !== ch.id) })} />
                        <span>{ch.label}{ch.hint ? <span className="fineprint">{ch.hint}</span> : null}</span>
                      </label>
                    ))}
                  </fieldset>
                  <details open={askedExtra}>
                    <summary>Advanced: scopes typed by hand{askedExtra ? " (the app asked for some)" : ""}</summary>
                    <label htmlFor="c-scopes">Extra scopes, one per line</label>
                    <textarea id="c-scopes" className="text-input" rows={3} value={form.extra} onChange={(e) => setForm({ ...form, extra: e.target.value })} spellCheck={false} aria-describedby="c-scopes-hint" />
                    <p id="c-scopes-hint" className="fineprint">Your names: {c.domains.length ? c.domains.join(", ") : "none yet"}. For example <code>dns.read:example.com</code> or <code>register.propose:*</code>.{c.ignored_scopes ? ` ${c.ignored_scopes} scope${c.ignored_scopes === 1 ? "" : "s"} it asked for were not valid and are not offered.` : ""}</p>
                  </details>
                  {spends && (
                    <>
                      <label htmlFor="c-cap">Most it can ask you to spend, in dollars</label>
                      <input id="c-cap" className="text-input" inputMode="decimal" value={form.cap} placeholder="50" required onChange={(e) => setForm({ ...form, cap: e.target.value })} aria-describedby="c-cap-hint" />
                      <p id="c-cap-hint" className="fineprint">A ceiling across all of its suggestions. You still approve every purchase with your passkey and pay on Stripe.</p>
                    </>
                  )}
                  <label htmlFor="c-days">How long it stays connected</label>
                  <select id="c-days" className="text-input" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
                    <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days (the longest)</option>
                  </select>
                  <p className="fineprint">It will hold: {scopes.length ? scopes.map(describeScope).join("; ") : "nothing yet"}. You can pause or disconnect it any time under Account, Connected apps.</p>
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
