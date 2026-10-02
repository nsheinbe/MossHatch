import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import type { StepUpType } from "../lib/domains";
import { createToken, explainVisitor, listApproved, listPending, listVisitors, narrowToken, revokeVisitor, sendHome, setDeviceLogin, setThreshold, usd, when, widenToken, type RequestSummary, type Visitor, type VisitorList } from "../lib/visitors";
import { ApiError } from "../lib/api";
import { StepUp, type StepUpRequest } from "./StepUp";

const ApprovalCard = lazy(() => import("./ApprovalCard"));

const KIND = (v: Visitor) => (v.connected_app ? "Connected app" : v.kind === "cli" ? "Command-line sign-in" : "Token");
const lines = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);
const minor = (dollars: string) => Math.round(Number(dollars || "0") * 100);

/** The everyday choices for a new token, in plain words. Each applies to every name you own; anything narrower is under Advanced. */
const CHOICES = [
  { scope: "domains.read:*", label: "See my names", hint: "Names, expiry dates and settings." },
  { scope: "dns.read:*", label: "Read DNS records" },
  { scope: "dns.write:*", label: "Change DNS records", hint: "Changes to mail, nameservers and other sensitive records still wait for your passkey." },
  { scope: "register.propose:*", label: "Suggest names to buy", hint: "Nothing is bought until you approve it with your passkey." },
  { scope: "renew.propose:*", label: "Suggest renewals", hint: "You approve each one." },
  { scope: "transfer.status:*", label: "Check transfers in progress" },
] as const;
/** Whether any of these scopes lets the token ask you to pay, so a spend cap means something. */
const canSpend = (scopes: readonly string[]) => scopes.some((x) => /^(register|renew)\.propose:/.test(x));

const WORDS: Record<string, string> = {
  "domains.read": "See names", "dns.read": "Read DNS", "dns.write": "Change DNS", "nest.names": "List secret names", "secrets.read": "Read secrets",
  "secrets.write": "Write secrets", "recipes.plan": "Plan recipes", "recipes.apply": "Apply recipes", "register.propose": "Suggest names to buy",
  "renew.propose": "Suggest renewals", "transfer.status": "Check transfers", "mandate.off": "Turn auto-renew off",
};
/** "dns.write:example.com" reads as "Change DNS on example.com"; the raw scope is still shown next to it. */
function describeScope(raw: string): string {
  const [cap = "", res = "", env] = raw.split(":");
  if (cap === "domains.read") return res === "*" ? "See all names" : `See ${res}`;
  return `${WORDS[cap] ?? cap} ${res === "*" ? "on all names" : `on ${res}`}${env ? (env === "*" ? ", every environment" : `, ${env}`) : ""}`;
}

/**
 * Visitors (PLAN 4.5, threat row 15): everything that holds a token for this account, what it may do, when it was last used and
 * what it has spent; the requests waiting for you; one button that sends every visitor home. Lazy chunk, opened from Account.
 * A new token is shown once, here, and kept only in this component's state.
 */
export default function Visitors() {
  const { account, set } = useUi();
  const [data, setData] = useState<VisitorList | null>(null);
  const [pending, setPending] = useState<RequestSummary[]>([]);
  const [approved, setApproved] = useState<RequestSummary[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [confirmHome, setConfirmHome] = useState(false);
  const [form, setForm] = useState({ name: "", picks: ["domains.read:*"] as string[], extra: "", cap: "0", days: "30" });
  const [change, setChange] = useState({ scopes: "", cap: "", days: "" });
  const [threshold, setThr] = useState("");
  const head = useRef<HTMLHeadingElement>(null);
  const close = useCallback(() => set({ visitorsOpen: false }), [set]);

  const load = useCallback(async () => {
    try {
      const [v, p, a] = await Promise.all([listVisitors(), listPending(), listApproved()]);
      setData(v); setPending(p.approvals); setApproved(a.approvals); setThr((Number(v.confirm_threshold_minor) / 100).toFixed(2));
    } catch (e) { setMsg(explainVisitor(e)); }
  }, []);
  useEffect(() => { void load(); head.current?.focus(); }, [load]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !req && !open) close(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [close, req, open]);

  const done = (m: string) => { setOpen(null); setMsg(m); void load(); };
  const create = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!account) return;
    setMsg(null); setMade(null);
    const scopes = [...new Set([...form.picks, ...lines(form.extra)])];
    if (!form.name.trim()) { setMsg("Give the token a name, like the app or agent that will use it."); return; }
    if (scopes.length === 0) { setMsg("Pick at least one thing the token can do."); return; }
    const spends = canSpend(scopes);
    const input = { name: form.name.trim(), scopes, spend_cap_minor: spends ? minor(form.cap) : 0, expires_in_days: Number(form.days) };
    setReq({ type: "agent.token.create" as StepUpType, target: account.user.id, input, run: async (actionId) => { const t = await createToken(actionId); setMade({ name: input.name, token: t.token }); await load(); } });
  };
  const applyChange = async (v: Visitor) => {
    setMsg(null);
    const body = { scopes: change.scopes ? lines(change.scopes) : v.scopes, ...(change.cap ? { spend_cap_minor: minor(change.cap) } : {}), ...(change.days ? { expires_in_days: Number(change.days) } : {}) };
    try { await narrowToken(v.id, body); setEdit(null); done("Narrowed. No passkey was needed because the token can now do less."); }
    catch (e) {
      if (e instanceof ApiError && e.code === "step_up_required") {
        setReq({ type: "agent.token.widen" as StepUpType, target: v.id, input: body, run: async (actionId) => { await widenToken(v.id, actionId); setEdit(null); done("Changed. We emailed you a note about it."); } });
      } else setMsg(explainVisitor(e));
    }
  };
  const revoke = async (v: Visitor) => { try { await revokeVisitor(v.id); done(`Revoked ${v.name}. It no longer works anywhere.`); } catch (e) { setMsg(explainVisitor(e)); } };
  const home = async () => { try { const r = await sendHome(); setConfirmHome(false); done(`Every visitor was sent home (${r.revoked} revoked). Waiting requests were declined.`); } catch (e) { setMsg(explainVisitor(e)); } };
  const saveThreshold = async (ev: React.FormEvent) => { ev.preventDefault(); try { await setThreshold(minor(threshold)); setMsg("Saved."); } catch (e) { setMsg(explainVisitor(e)); } };

  const live = (data?.visitors ?? []).filter((v) => !v.revoked_at);
  const openCard = open ? pending.concat(approved).find((r) => r.id === open) : null;
  return (
    <main>
      <div className="panel ledger visitors" role="region" aria-labelledby="visitors-h">
        <div className="head"><h2 id="visitors-h" ref={head} tabIndex={-1}>Visitors</h2></div>
        <div className="body">
          <p className="notice">Apps, AI agents and command-line tools you have let act for you. None of them can buy anything or change sensitive DNS without your passkey, and you can take access back at any time.</p>
          {msg && <p role="status" className="notice">{msg}</p>}
          {!data && !msg && <p role="status">Loading.</p>}
          {open && openCard && (
            <Suspense fallback={<p role="status">Loading.</p>}>
              <ApprovalCard id={open} onClose={() => setOpen(null)} onDone={done} />
            </Suspense>
          )}
          {!open && data && (
            <>
              <section className="section" aria-labelledby="waiting-h">
                <h3 id="waiting-h">Waiting for you</h3>
                {pending.length === 0 && approved.length === 0 ? <p>Nothing is waiting.</p> : (
                  <ul className="plain">
                    {pending.map((r) => (
                      <li key={r.id}>
                        <strong>{r.requester.name}</strong> asks to {r.kind === "register" ? "register" : r.kind === "renew" ? "renew" : r.kind === "dns_change" ? "change DNS on" : "get more access"} {r.domain ? r.domain.unicode : ""}{r.max_total_minor !== "0" ? `, up to ${usd(r.max_total_minor)}` : ""}.{" "}
                        <button type="button" className="btn secondary small" onClick={() => { setMsg(null); setOpen(r.id); }}>Review</button>
                      </li>
                    ))}
                    {approved.map((r) => (
                      <li key={r.id}>You approved <strong>{r.requester.name}</strong>: {r.domain?.unicode ?? "a request"}.{" "}
                        <button type="button" className="btn secondary small" onClick={() => { setMsg(null); setOpen(r.id); }}>Open</button></li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="section" aria-labelledby="who-h">
                <h3 id="who-h">Who has access</h3>
                {live.length === 0 ? <p>Nothing has access yet. Create a token below to let an app or agent work with your names.</p> : (
                  <div className="table-wrap">
                    <table className="data">
                      <caption className="sr-only">Tokens and connected apps</caption>
                      <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Can do</th><th scope="col">Last used</th><th scope="col">Expires</th><th scope="col">Spent of cap</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                      <tbody>
                        {live.map((v) => (
                          <tr key={v.id}>
                            <td>{v.name}{v.paused ? " (paused)" : ""}<br /><code className="fineprint">{v.prefix}</code></td>
                            <td>{KIND(v)}{v.connected_app?.redirect_host ? <><br /><span className="fineprint">returns to {v.connected_app.redirect_host}</span></> : null}{v.connected_app?.reported_name ? <><br /><span className="fineprint">calls itself {v.connected_app.reported_name} (not verified)</span></> : null}</td>
                            <td><ul className="plain">{v.scopes.map((s) => <li key={s}>{describeScope(s)} <code className="fineprint">{s}</code></li>)}</ul></td>
                            <td>{when(v.last_used_at)}</td>
                            <td>{when(v.expires_at)}</td>
                            <td>{v.kind === "agent" ? `${usd(v.spend.spent_minor)} of ${usd(v.spend.cap_minor)}` : "Cannot spend"}</td>
                            <td>
                              <button type="button" className="btn secondary small" aria-label={`Change what ${v.name} can do`} onClick={() => { setEdit(v.id); setChange({ scopes: v.scopes.join("\n"), cap: "", days: "" }); }}>Change</button>{" "}
                              <button type="button" className="btn secondary small" aria-label={`Revoke ${v.name}`} onClick={() => void revoke(v)}>Revoke</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {edit && (() => { const v = live.find((x) => x.id === edit); if (!v) return null; return (
                  <form className="form-grid" aria-label={`Change ${v.name}`} onSubmit={(e) => { e.preventDefault(); void applyChange(v); }}>
                    <label htmlFor="chg-scopes">What {v.name} can do, one scope per line</label>
                    <textarea id="chg-scopes" className="text-input" rows={4} value={change.scopes} onChange={(e) => setChange({ ...change, scopes: e.target.value })} spellCheck={false} />
                    <label htmlFor="chg-cap">Spend cap in dollars (leave empty to keep)</label>
                    <input id="chg-cap" className="text-input" inputMode="decimal" value={change.cap} onChange={(e) => setChange({ ...change, cap: e.target.value })} />
                    <label htmlFor="chg-days">Days from now until it expires (leave empty to keep)</label>
                    <input id="chg-days" className="text-input" inputMode="numeric" value={change.days} onChange={(e) => setChange({ ...change, days: e.target.value })} />
                    <p className="fineprint">Less access is saved at once. More access, a higher cap or a later expiry needs your passkey.</p>
                    <div className="row-actions"><button type="submit" className="btn primary">Save</button><button type="button" className="btn secondary" onClick={() => setEdit(null)}>Cancel</button></div>
                  </form>
                ); })()}
              </section>

              <section className="section" aria-labelledby="new-h">
                <h3 id="new-h">New token</h3>
                <p className="fineprint">A token is a key you paste into an app or agent so it can work with your names. You see it once.</p>
                {made ? (
                  <div>
                    {/* Only the sentence is announced; a live region would read the token itself aloud. */}
                    <p role="status">Here is the token for {made.name}. It is shown once. Store it where the program reads it, never in a repository.</p>
                    <p><code className="token-once" style={{ wordBreak: "break-all" }}>{made.token}</code></p>
                    <div className="row-actions"><button type="button" className="btn secondary" onClick={() => setMade(null)}>I stored it</button></div>
                  </div>
                ) : (
                  <form className="form-grid" onSubmit={create}>
                    <label htmlFor="tok-name">Name</label>
                    <input id="tok-name" className="text-input" value={form.name} placeholder="For example: Claude, deploy script" onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={64} />
                    <fieldset className="choices">
                      <legend>What it can do</legend>
                      {CHOICES.map((c) => (
                        <label key={c.scope} className="check">
                          <input type="checkbox" checked={form.picks.includes(c.scope)} onChange={(e) => setForm({ ...form, picks: e.target.checked ? [...form.picks, c.scope] : form.picks.filter((x) => x !== c.scope) })} />
                          <span>{c.label}{"hint" in c ? <span className="fineprint">{c.hint}</span> : null}</span>
                        </label>
                      ))}
                    </fieldset>
                    {canSpend([...form.picks, ...lines(form.extra)]) ? (
                      <>
                        <label htmlFor="tok-cap">Most it can ask you to spend, in dollars</label>
                        <input id="tok-cap" className="text-input" inputMode="decimal" value={form.cap} onChange={(e) => setForm({ ...form, cap: e.target.value })} aria-describedby="tok-cap-hint" />
                        <p id="tok-cap-hint" className="fineprint">A ceiling across all its suggestions. You still approve every purchase yourself.</p>
                      </>
                    ) : null}
                    <label htmlFor="tok-days">Expires after</label>
                    <select id="tok-days" className="text-input" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
                      <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days (the longest)</option>
                    </select>
                    <details>
                      <summary>Advanced: one name only, secrets, recipes</summary>
                      <label htmlFor="tok-scopes">Extra scopes, one per line</label>
                      <textarea id="tok-scopes" className="text-input" rows={3} value={form.extra} onChange={(e) => setForm({ ...form, extra: e.target.value })} spellCheck={false} aria-describedby="tok-scopes-hint" />
                      <p id="tok-scopes-hint" className="fineprint">For example <code>dns.read:example.com</code>, <code>secrets.read:example.com:dev</code> or <code>recipes.plan:example.com</code>. Production secrets need <code>:prod</code> and a name.</p>
                    </details>
                    <div className="row-actions"><button type="submit" className="btn primary" disabled={!account}>Create with passkey</button></div>
                  </form>
                )}
              </section>

              {req && <StepUp req={req} onDone={() => setReq(null)} />}

              <section className="section" aria-labelledby="settings-h">
                <h3 id="settings-h">Settings</h3>
                <form className="form-grid" onSubmit={(e) => void saveThreshold(e)}>
                  <label htmlFor="thr">Ask me to type the name when a request can cost more than (dollars)</label>
                  <input id="thr" className="text-input" inputMode="decimal" value={threshold} onChange={(e) => setThr(e.target.value)} />
                  <div className="row-actions"><button type="submit" className="btn secondary">Save</button></div>
                </form>
                <label className="check"><input type="checkbox" checked={data.device_login_enabled} onChange={(e) => void setDeviceLogin(e.target.checked).then(load).catch((x) => setMsg(explainVisitor(x)))} /> Allow command-line sign-in</label>
              </section>

              <section className="section" aria-labelledby="home-h">
                <h3 id="home-h">Send all visitors home</h3>
                <p>Revokes every token, command-line sign-in and connected app at once, and declines every waiting request. It works even when something is going wrong.</p>
                {confirmHome ? (
                  <div className="row-actions" role="group" aria-label="Confirm sending every visitor home">
                    <button type="button" className="btn primary" onClick={() => void home()}>Yes, send them all home</button>
                    <button type="button" className="btn secondary" onClick={() => setConfirmHome(false)}>Cancel</button>
                  </div>
                ) : <div className="row-actions"><button type="button" className="btn secondary" onClick={() => setConfirmHome(true)}>Send all visitors home</button></div>}
              </section>
            </>
          )}
          <div className="row-actions"><button type="button" className="btn secondary" onClick={close}>Close</button></div>
        </div>
      </div>
    </main>
  );
}
