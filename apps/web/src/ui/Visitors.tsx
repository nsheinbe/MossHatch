import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import type { StepUpType } from "../lib/domains";
import {
  createToken, describeActivity, explainVisitor, getActivity, listApproved, listPending, listVisitors, narrowToken, pauseToken, revokeVisitor, sendHome,
  setDeviceLogin, setThreshold, usd, when, widenToken, type ActivityEntry, type RequestSummary, type Visitor, type VisitorList,
} from "../lib/visitors";
import { CHOICES, canSpend, describeScope, lines, minor, scopesFor } from "../lib/scopes";
import { ApiError } from "../lib/api";
import { StepUp, type StepUpRequest } from "./StepUp";
import { sayWaiting } from "../lib/waiting";
import { openWaiting } from "./Waiting";

const ApprovalCard = lazy(() => import("./ApprovalCard"));

const KIND = (v: Visitor) => (v.connected_app ? "Connected app" : v.kind === "cli" ? "Command-line sign-in" : "Token");
const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { dateStyle: "medium" });
async function copy(text: string, say: (m: string) => void, done = "Copied.") {
  try { await navigator.clipboard.writeText(text); say(done); } catch { say("Could not copy. Select the text and copy it by hand."); }
}

/** How a token is used, with `<token>` shown and the real one only in the copied text (it is on screen once, above). */
function TokenUses({ token, say }: { token: string; say: (m: string) => void }) {
  const mcp = `${location.origin}/mcp`;
  const uses: [string, string][] = [
    ["Claude Code", `claude mcp add --transport http mosshatch ${mcp} --header "Authorization: Bearer <token>"`],
    ["Cursor (~/.cursor/mcp.json)", `{ "mcpServers": { "mosshatch": { "url": "${mcp}", "headers": { "Authorization": "Bearer <token>" } } } }`],
    ["A script (curl)", `curl -H "Authorization: Bearer <token>" ${location.origin}/api/v1/agent/domains`],
  ];
  return (
    <details className="token-uses">
      <summary>How to use it</summary>
      <p className="fineprint">Give it to the program or person privately, for example through a password manager, never in an email or a repository. A command you paste into a terminal stays in its history: clear it afterwards.</p>
      <ul className="plain">
        {uses.map(([label, line]) => (
          <li key={label}>
            <strong>{label}</strong>
            <code className="use-line">{line}</code>
            <button type="button" className="btn secondary small" onClick={() => void copy(line.replace("<token>", token), say, `Copied the ${label} line with the token in it.`)}>Copy with the token</button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** The front door: how to connect Claude (or another assistant) with sign-in, no token to handle. */
function ConnectAssistant({ say }: { say: (m: string) => void }) {
  const mcp = `${location.origin}/mcp`;
  return (
    <section className="section" aria-labelledby="assist-h">
      <h3 id="assist-h">Connect Claude or another assistant</h3>
      <p>Give your assistant this address. It opens Mosshatch so you can sign in, choose what it may do and confirm with your passkey. It runs on your own assistant plan; Mosshatch charges nothing for it.</p>
      <div className="row-actions copy-row">
        <code className="use-line">{mcp}</code>
        <button type="button" className="btn secondary small" onClick={() => void copy(mcp, say, "Copied the address.")}>Copy</button>
      </div>
      <details>
        <summary>Claude: claude.ai, the desktop and mobile apps</summary>
        <p>Open Settings, then Connectors, and choose Add custom connector. Name it Mosshatch, paste the address, and connect. A connector added on claude.ai also works in the Claude apps.</p>
      </details>
      <details>
        <summary>Claude Code</summary>
        <p><code className="use-line">claude mcp add --transport http mosshatch {mcp}</code></p>
        <p>Then type <code>/mcp</code> in Claude Code and choose Mosshatch to sign in.</p>
      </details>
      <details>
        <summary>ChatGPT, Cursor and others</summary>
        <p>ChatGPT: turn on developer mode under Settings, Apps and connectors, Advanced, then create a connector with this address. Cursor: add <code>{`{ "mcpServers": { "mosshatch": { "url": "${mcp}" } } }`}</code> to <code>~/.cursor/mcp.json</code>. Any assistant that connects to remote MCP servers with sign-in works the same way.</p>
      </details>
      <p className="fineprint">Once connected it can check names and prices, read and change DNS, connect a name to Vercel, Resend or Neon, and suggest names to buy or renew, as far as you allow. Steps for every assistant: <a href="/assistants">mosshatch.com/assistants</a>.</p>
    </section>
  );
}

/**
 * Connected apps (PLAN 4.5, threat row 15): the front door for assistants; everything that holds access to this account, what it may
 * do, what it did, and when it ends; pause, resume, change and revoke; the requests waiting for you; tokens for scripts and people;
 * and one button that disconnects everything. A new token is shown once, here, and kept only in this component's state. Lazy chunk.
 */
export default function Visitors() {
  const { account, set, visitorsCard, waiting } = useUi();
  const [data, setData] = useState<VisitorList | null>(null);
  const [pending, setPending] = useState<RequestSummary[]>([]);
  const [approved, setApproved] = useState<RequestSummary[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [made, setMade] = useState<{ name: string; token: string } | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [acts, setActs] = useState<{ id: string; rows: ActivityEntry[] | null; all: boolean } | null>(null);
  const [confirmHome, setConfirmHome] = useState(false);
  const [form, setForm] = useState({ name: "", picks: ["see"] as string[], which: "all" as "all" | "one", one: "", extra: "", cap: "", days: "30" });
  const [names, setNames] = useState<string[] | null>(null);
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
  // Opened on one request (the Account button, the page's notice, a creature): show its card at once.
  useEffect(() => { if (visitorsCard) { setOpen(visitorsCard); set({ visitorsCard: null }); } }, [visitorsCard, set]);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !req && !open) close(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [close, req, open]);
  // The names list, only when someone chooses one name.
  useEffect(() => {
    if (form.which !== "one" || names) return;
    void import("../lib/domains").then((m) => m.listDomains()).then((o) => { const n = o.domains.map((d) => d.fqdn).sort(); setNames(n); setForm((f) => ({ ...f, one: f.one || n[0] || "" })); }).catch(() => setNames([]));
  }, [form.which, names]);

  const decided = () => { const st = useUi.getState(); set({ waitingRev: st.waitingRev + 1, groveRev: st.groveRev + 1 }); };
  const done = (m: string) => { setOpen(null); setMsg(m); decided(); void load(); };
  const target = form.which === "one" && form.one ? form.one : "*";
  const scopes = [...new Set([...scopesFor(form.picks, target), ...lines(form.extra)])];
  const spends = canSpend(scopes);
  const create = (ev: React.FormEvent) => {
    ev.preventDefault();
    if (!account) return;
    setMsg(null); setMade(null);
    if (!form.name.trim()) { setMsg("Give the token a name, like the app, the script or the person who will use it."); return; }
    if (form.which === "one" && !form.one) { setMsg("Choose the name it may work with."); return; }
    if (scopes.length === 0) { setMsg("Pick at least one thing the token can do."); return; }
    // A spending token with a cap of zero could suggest nothing: every suggestion would be over it.
    if (spends && !(minor(form.cap) > 0)) { setMsg("Set the most it can ask you to spend, in dollars. With nothing there it could not suggest anything."); return; }
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
  const pause = async (v: Visitor) => { try { await pauseToken(v.id); done(`Paused ${v.name}. It cannot do anything until you resume it with your passkey.`); } catch (e) { setMsg(explainVisitor(e)); } };
  const resume = (v: Visitor) => { setMsg(null); setReq({ type: "agent.token.widen" as StepUpType, target: v.id, input: { scopes: v.scopes }, run: async (actionId) => { await widenToken(v.id, actionId); done(`Resumed ${v.name}.`); } }); };
  const revoke = async (v: Visitor) => { try { await revokeVisitor(v.id); done(`Revoked ${v.name}. It no longer works anywhere.`); } catch (e) { setMsg(explainVisitor(e)); } };
  const activity = async (v: Visitor) => {
    if (acts?.id === v.id) { setActs(null); return; }
    setActs({ id: v.id, rows: null, all: false });
    try { const rows = await getActivity(v.id); setActs({ id: v.id, rows, all: false }); } catch (e) { setActs(null); setMsg(explainVisitor(e)); }
  };
  const home = async () => { try { const r = await sendHome(); setConfirmHome(false); done(`Everything was disconnected (${r.revoked} revoked). Waiting requests were declined.`); } catch (e) { setMsg(explainVisitor(e)); } };
  const saveThreshold = async (ev: React.FormEvent) => { ev.preventDefault(); try { await setThreshold(minor(threshold)); setMsg("Saved."); } catch (e) { setMsg(explainVisitor(e)); } };

  const live = (data?.visitors ?? []).filter((v) => !v.revoked_at);
  // Recipe plans a token made wait on the name's Connect tab; they are listed here too, so this list is everything that waits.
  const plans = waiting.filter((w) => w.source === "recipe");
  const openCard = open ? pending.concat(approved).find((r) => r.id === open) ?? { id: open } : null;
  const actsOf = acts ? live.find((v) => v.id === acts.id) : null;
  return (
    <main>
      <div className="panel ledger visitors" role="region" aria-labelledby="visitors-h">
        <div className="head"><h2 id="visitors-h" ref={head} tabIndex={-1}>Connected apps</h2></div>
        <div className="body">
          <p className="notice">Claude and other assistants, and the scripts and people you give a token to. None of them can buy a name or change sensitive DNS without your passkey, and you can pause or disconnect any of them here.</p>
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
                {pending.length === 0 && approved.length === 0 && plans.length === 0 ? <p>Nothing is waiting.</p> : (
                  <ul className="plain">
                    {pending.map((r) => (
                      <li key={r.id}>
                        <strong>{r.requester.name}</strong> asks to {r.kind === "register" ? "register" : r.kind === "renew" ? "renew" : r.kind === "nameservers_change" ? "request nameservers for" : r.kind === "dns_change" ? "change DNS on" : "get more access"} {r.domain ? r.domain.unicode : ""}{r.max_total_minor !== "0" ? `, up to ${usd(r.max_total_minor)}` : ""}.{" "}
                        <button type="button" className="btn secondary small" onClick={() => { setMsg(null); setOpen(r.id); }}>Review</button>
                      </li>
                    ))}
                    {plans.map((w) => (
                      <li key={w.id}>{sayWaiting(w)}{" "}
                        <button type="button" className="btn secondary small" onClick={() => openWaiting(w)}>Review</button></li>
                    ))}
                    {approved.map((r) => (
                      <li key={r.id}>You approved <strong>{r.requester.name}</strong>: {r.domain?.unicode ?? "a request"}.{" "}
                        <button type="button" className="btn secondary small" onClick={() => { setMsg(null); setOpen(r.id); }}>Open</button></li>
                    ))}
                  </ul>
                )}
              </section>

              <ConnectAssistant say={setMsg} />

              <section className="section" aria-labelledby="who-h">
                <h3 id="who-h">Who has access</h3>
                {live.length === 0 ? <p>Nothing is connected yet. Connect your assistant above, or make a token below for a script or a person you trust with one name.</p> : (
                  <div className="table-wrap">
                    <table className="data">
                      <caption className="sr-only">Tokens and connected apps</caption>
                      <thead><tr><th scope="col">Name</th><th scope="col">Kind</th><th scope="col">Can do</th><th scope="col">Last used</th><th scope="col">Ends</th><th scope="col">Spent of cap</th><th scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                      <tbody>
                        {live.map((v) => (
                          <tr key={v.id}>
                            <td>{v.name}{v.paused ? <><br /><span className="warn">Paused</span></> : null}<br /><code className="fineprint">{v.prefix}</code></td>
                            <td>{KIND(v)}{v.connected_app?.redirect_host ? <><br /><span className="fineprint">returns to {v.connected_app.redirect_host}</span></> : null}{v.connected_app?.reported_name ? <><br /><span className="fineprint">calls itself {v.connected_app.reported_name} (not verified)</span></> : null}</td>
                            <td><ul className="plain">{v.scopes.map((s) => <li key={s}>{describeScope(s)} <code className="fineprint">{s}</code></li>)}</ul></td>
                            <td>{when(v.last_used_at)}</td>
                            <td>{v.connected_app ? <>Reconnect by<br />{day(v.expires_at)}</> : day(v.expires_at)}</td>
                            <td>{v.kind === "agent" ? `${usd(v.spend.spent_minor)} of ${usd(v.spend.cap_minor)}` : "Cannot spend"}</td>
                            <td className="row-buttons">
                              <button type="button" className="btn secondary small" aria-expanded={acts?.id === v.id} aria-label={`What ${v.name} did`} onClick={() => void activity(v)}>Activity</button>
                              {v.paused
                                ? <button type="button" className="btn secondary small" aria-label={`Resume ${v.name}`} onClick={() => resume(v)}>Resume</button>
                                : <button type="button" className="btn secondary small" aria-label={`Pause ${v.name}`} onClick={() => void pause(v)}>Pause</button>}
                              <button type="button" className="btn secondary small" aria-label={`Change what ${v.name} can do`} onClick={() => { setEdit(v.id); setChange({ scopes: v.scopes.join("\n"), cap: "", days: "" }); }}>Change</button>
                              <button type="button" className="btn secondary small" aria-label={`Revoke ${v.name}`} onClick={() => void revoke(v)}>Revoke</button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {acts && actsOf && (
                  <div className="activity" role="group" aria-labelledby="act-h">
                    <h4 id="act-h">What {actsOf.name} did</h4>
                    {!acts.rows ? <p role="status">Loading.</p> : acts.rows.length === 0 ? <p>Nothing yet.</p> : (
                      <>
                        <ul className="plain">{(acts.all ? acts.rows : acts.rows.slice(0, 20)).map((a, i) => <li key={`${a.at}${i}`}><span className="fineprint">{when(a.at)}</span> {describeActivity(a)}</li>)}</ul>
                        {!acts.all && acts.rows.length > 20 && <button type="button" className="btn secondary small" onClick={() => setActs({ ...acts, all: true })}>Show all {acts.rows.length}</button>}
                      </>
                    )}
                  </div>
                )}
                {edit && (() => { const v = live.find((x) => x.id === edit); if (!v) return null; return (
                  <form className="form-grid" aria-label={`Change ${v.name}`} onSubmit={(e) => { e.preventDefault(); void applyChange(v); }}>
                    <label htmlFor="chg-scopes">What {v.name} can do, one scope per line</label>
                    <textarea id="chg-scopes" className="text-input" rows={4} value={change.scopes} onChange={(e) => setChange({ ...change, scopes: e.target.value })} spellCheck={false} />
                    <label htmlFor="chg-cap">Spend cap in dollars (leave empty to keep)</label>
                    <input id="chg-cap" className="text-input" inputMode="decimal" value={change.cap} onChange={(e) => setChange({ ...change, cap: e.target.value })} />
                    <label htmlFor="chg-days">Days from now until it ends, 1 to 90 (leave empty to keep)</label>
                    <input id="chg-days" className="text-input" inputMode="numeric" min={1} max={90} value={change.days} onChange={(e) => setChange({ ...change, days: e.target.value })} />
                    <p className="fineprint">Less access is saved at once. More access, a higher cap or a later end needs your passkey.</p>
                    <div className="row-actions"><button type="submit" className="btn primary">Save</button><button type="button" className="btn secondary" onClick={() => setEdit(null)}>Cancel</button></div>
                  </form>
                ); })()}
              </section>

              <section className="section" aria-labelledby="new-h">
                <h3 id="new-h">New token</h3>
                <p className="fineprint">For a script, a server, or a person you trust, like a developer working on one name. A token is a key: whoever holds it can do what you tick below until it ends or you revoke it. You see it once.</p>
                {made ? (
                  <div>
                    {/* Only the sentence is announced; a live region would read the token itself aloud. */}
                    <p role="status">Here is the token for {made.name}. It is shown once. Store it where the program reads it, never in a repository.</p>
                    <p><code className="token-once" style={{ wordBreak: "break-all" }}>{made.token}</code></p>
                    <div className="row-actions">
                      <button type="button" className="btn secondary" onClick={() => void copy(made.token, setMsg)}>Copy</button>
                      <button type="button" className="btn secondary" onClick={() => setMade(null)}>I stored it</button>
                    </div>
                    <TokenUses token={made.token} say={setMsg} />
                  </div>
                ) : (
                  <form className="form-grid" onSubmit={create}>
                    <label htmlFor="tok-name">Name</label>
                    <input id="tok-name" className="text-input" value={form.name} placeholder="For example: deploy script, or Sam (developer)" onChange={(e) => setForm({ ...form, name: e.target.value })} maxLength={64} required autoComplete="off" />
                    <fieldset className="choices">
                      <legend>Which names</legend>
                      <label className="check"><input type="radio" name="tok-which" checked={form.which === "all"} onChange={() => setForm({ ...form, which: "all", picks: form.picks.filter((id) => !CHOICES.find((c) => c.id === id)?.domainOnly) })} /> <span>All my names</span></label>
                      <label className="check"><input type="radio" name="tok-which" checked={form.which === "one"} onChange={() => setForm({ ...form, which: "one" })} /> <span>Only one name</span></label>
                      {form.which === "one" && (names === null ? <p role="status" className="fineprint">Loading your names.</p> : names.length === 0 ? <p className="fineprint">You have no names yet.</p> : (
                        <label>The name
                          <select className="text-input" value={form.one} onChange={(e) => setForm({ ...form, one: e.target.value })}>{names.map((n) => <option key={n} value={n}>{n}</option>)}</select>
                        </label>
                      ))}
                    </fieldset>
                    <fieldset className="choices">
                      <legend>What it can do</legend>
                      {CHOICES.map((c) => (
                        <label key={c.id} className="check">
                          <input type="checkbox" checked={form.picks.includes(c.id)} disabled={c.domainOnly && form.which === "all"} onChange={(e) => setForm({ ...form, picks: e.target.checked ? [...form.picks, c.id] : form.picks.filter((x) => x !== c.id) })} />
                          <span>{c.label}{c.hint ? <span className="fineprint">{c.hint}</span> : null}</span>
                        </label>
                      ))}
                    </fieldset>
                    <p className="fineprint">Start with read access if that is enough. The assistant can request specific extra access later; adding it needs your passkey. A request alone never grants access.</p>
                    {spends ? (
                      <>
                        <label htmlFor="tok-cap">Most it can ask you to spend, in dollars</label>
                        <input id="tok-cap" className="text-input" inputMode="decimal" value={form.cap} placeholder="50" required onChange={(e) => setForm({ ...form, cap: e.target.value })} aria-describedby="tok-cap-hint" />
                        <p id="tok-cap-hint" className="fineprint">A ceiling across all of its suggestions. You still approve every purchase with your passkey, and nothing is charged before that.</p>
                      </>
                    ) : null}
                    <label htmlFor="tok-days">Expires after</label>
                    <select id="tok-days" className="text-input" value={form.days} onChange={(e) => setForm({ ...form, days: e.target.value })}>
                      <option value="7">7 days</option><option value="30">30 days</option><option value="90">90 days (the longest)</option>
                    </select>
                    <details>
                      <summary>Advanced: secrets, production, single scopes</summary>
                      <label htmlFor="tok-scopes">Extra scopes, one per line</label>
                      <textarea id="tok-scopes" className="text-input" rows={3} value={form.extra} onChange={(e) => setForm({ ...form, extra: e.target.value })} spellCheck={false} aria-describedby="tok-scopes-hint" />
                      <p id="tok-scopes-hint" className="fineprint">For example <code>dns.read:example.com</code>, <code>secrets.read:example.com:dev</code> or <code>recipes.plan:example.com</code>. Production secrets need <code>:prod</code> and a name.</p>
                    </details>
                    {scopes.length > 0 && <p className="fineprint">It will hold: {scopes.map(describeScope).join("; ")}.</p>}
                    <div className="row-actions"><button type="submit" className="btn primary" disabled={!account}>Create with passkey</button></div>
                  </form>
                )}
              </section>

              {req && <StepUp req={req} onDone={() => setReq(null)} />}

              <section className="section" aria-labelledby="settings-h">
                <h3 id="settings-h">Settings</h3>
                <form className="form-grid" onSubmit={(e) => void saveThreshold(e)}>
                  <label htmlFor="thr">For a request that could cost more than this (dollars), ask me to type the domain name as well as use my passkey</label>
                  <input id="thr" className="text-input" inputMode="decimal" value={threshold} onChange={(e) => setThr(e.target.value)} />
                  <div className="row-actions"><button type="submit" className="btn secondary">Save</button></div>
                </form>
                <label className="check"><input type="checkbox" checked={data.device_login_enabled} onChange={(e) => void setDeviceLogin(e.target.checked).then(load).catch((x) => setMsg(explainVisitor(x)))} /> <span>Allow command-line sign-in<span className="fineprint">Lets the Mosshatch command-line tool sign in to this account with a code you approve here. The tool is not published yet.</span></span></label>
              </section>

              <section className="section" aria-labelledby="safe-h">
                <h3 id="safe-h">How we keep this safe</h3>
                <ul className="safe-list">
                  <li>Nothing is bought without your passkey. An assistant can only suggest a name or a renewal; you approve it, and you pay on Stripe.</li>
                  <li>Deletions and changes to sensitive DNS records or dependencies (mail, zone NS records, production, the name itself, www, verification) wait for your passkey.</li>
                  <li>Registry nameserver delegation is separate from a zone NS record. Agents can suggest a change for one granted name; execution remains blocked until destination verification is supported.</li>
                  <li>Before every DNS change, by you or a token, we keep a copy of the records for 30 days. Rollback needs a new review on the name's DNS tab and cannot undo lost mail or cached answers.</li>
                  <li>Every token ends within 90 days, and a token that may suggest purchases has a cap you set.</li>
                  <li>We email you when a token asks for your decision, when a production secret changes, and when everything is disconnected.</li>
                  <li>Pause stops a token at once, with no passkey. Only you can resume it, with your passkey.</li>
                </ul>
              </section>

              <section className="section" aria-labelledby="home-h">
                <h3 id="home-h">Disconnect everything</h3>
                <p>Revokes every token, command-line sign-in and connected app at once, and declines every waiting request. It works even when something is going wrong.</p>
                {confirmHome ? (
                  <div className="row-actions" role="group" aria-label="Confirm disconnecting everything">
                    <button type="button" className="btn primary" onClick={() => void home()}>Yes, disconnect everything</button>
                    <button type="button" className="btn secondary" onClick={() => setConfirmHome(false)}>Cancel</button>
                  </div>
                ) : <div className="row-actions"><button type="button" className="btn secondary" onClick={() => setConfirmHome(true)}>Disconnect everything</button></div>}
              </section>
            </>
          )}
          <div className="row-actions"><button type="button" className="btn secondary" onClick={close}>Close</button></div>
        </div>
      </div>
    </main>
  );
}
