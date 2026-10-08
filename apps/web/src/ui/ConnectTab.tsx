import { useCallback, useEffect, useState } from "react";
import type { DomainDetail, StepUpType } from "../lib/domains";
import {
  applyRecipe, approveApplication, checkConnection, connectService, disconnect, explainRecipe, getApplication, listApplications, listConnections, listRecipes, planRecipe,
  type ApplicationRow, type ConnectionView, type Finding, type Planned, type PlanView, type RecipeInfo, type Service,
} from "../lib/recipes";
import { useUi } from "../store";
import { StepUp, type StepUpRequest } from "./StepUp";

const PROVIDER: Record<Service, { name: string; ref: string | null; refHint: string; help: string; link: string }> = {
  vercel: { name: "Vercel", ref: "Project name or ID", refHint: "", help: "A Vercel access token scoped to the team (or the project) that owns your project: Vercel, Account Settings, Tokens.", link: "https://vercel.com/account/tokens" },
  resend: { name: "Resend", ref: null, refHint: "", help: "A Resend API key with full access: Resend, API Keys. The recipe uses it to add this name and to make a send-only key for your app.", link: "https://resend.com/api-keys" },
  neon: { name: "Neon", ref: "Project ID (optional)", refHint: "Leave it empty to have the recipe create a project for this name.", help: "A Neon API key: Neon, Account settings, API keys. The project ID is in the project's settings.", link: "https://console.neon.tech/app/settings/api-keys" },
};
const TARGET = (t: string) => { const [k, e] = t.split(":"); const env = e === "prod" || e === "production" ? "production" : e === "dev" || e === "development" ? "development" : e; return k === "nest" ? `your Nest (${env})` : `Vercel (${env})`; };
const STEP = (s: PlanView["steps"][number]) => {
  const what = s.op === "project.domain.add" ? `add ${s.target} to your project` : s.op === "env.upsert" ? `set environment variables (${s.target})` : s.op === "project.create" ? "create a new project"
    : s.op === "domain.create" ? `add ${s.target} as a sending domain` : s.op === "api_key.create" ? "make a send-only API key" : s.op;
  return `At ${PROVIDER[s.service as Service]?.name ?? s.service}: ${what}${s.cost === "free" ? "" : s.cost === "billable" ? " (may cost money at the provider)" : " (check the provider's pricing)"}.`;
};
const rec = (r: { type: string; name: string; value: string; priority?: number }) => `${r.type} ${r.name} ${r.priority !== undefined ? `${r.priority} ` : ""}${r.value}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ago = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" }) : "never");

function PlanBox({ plan, notices }: { plan: PlanView; notices: { text: string }[] }) {
  const sens = new Set(plan.sensitive.map((s) => `${s.type} ${s.name}`));
  return (
    <div className="plan-box">
      {plan.dns.add.length > 0 && <><h5>Records to add</h5><ul className="plain">{plan.dns.add.map((r) => <li key={rec(r)}><code>{rec(r)}</code>{sens.has(`${r.type} ${r.name}`) && <span className="warn"> sensitive</span>}</li>)}</ul></>}
      {plan.dns.remove.length > 0 && <><h5>Records to remove</h5><ul className="plain">{plan.dns.remove.map((r) => <li key={rec(r)}><code>{rec(r)}</code></li>)}</ul></>}
      {plan.pending_records.length > 0 && <p>The provider makes these records when the recipe runs, and they are written then: {plan.pending_records.map((r) => `${r.type} ${r.name}`).join(", ")}.</p>}
      {plan.variables.length > 0 && <><h5>Stored for your app</h5><ul className="plain">{plan.variables.map((v) => <li key={v.name}><code>{v.name}</code> in {v.targets.map(TARGET).join(" and ")}</li>)}</ul></>}
      {plan.steps.length > 0 && <ul className="plain">{plan.steps.map((s, i) => <li key={i}>{STEP(s)}</li>)}</ul>}
      {plan.dns.add.length + plan.dns.remove.length + plan.variables.length + plan.steps.length === 0 && <p>Nothing to change: everything is already in place.</p>}
      {notices.map((n) => <p key={n.text} className="notice">{n.text}</p>)}
      {plan.needs_approval && <p className="notice">This changes sensitive records or creates something at a provider, so it needs your passkey.</p>}
    </div>
  );
}

/** One recipe: its provider's connection, the options, the preview, the passkey when needed, and the run. */
function RecipeCard({ d, r, conns, row, onChanged, waitingId }: { d: DomainDetail; r: RecipeInfo; conns: ConnectionView[]; row: ApplicationRow | undefined; onChanged: () => void; waitingId: string | null }) {
  const service = r.services[0]!;
  const p = PROVIDER[service];
  const conn = conns.find((c) => c.service === service);
  const vercel = conns.find((c) => c.service === "vercel" && c.status === "active");
  const [token, setToken] = useState("");
  const [ref, setRef] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [planned, setPlanned] = useState<{ id: string; plan: PlanView; notices: { text: string }[]; state: string } | null>(null);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [opts, setOpts] = useState({ www: true, envs: ["dev"] as string[], region: "us-east-1", prefix: "", create: false, targets: [] as string[] });
  const [confirmOff, setConfirmOff] = useState(false);
  const fqdn = d.fqdn;

  // A plan a token made waits here for the owner (opened from the Account button, the page's notice or the grove).
  useEffect(() => {
    if (!waitingId) return;
    void getApplication(waitingId).then((a) => setPlanned({ id: a.application_id, plan: a.plan, notices: [], state: a.state })).catch((e) => setMsg(explainRecipe(e)));
  }, [waitingId]);

  const input = (): Record<string, unknown> => service === "vercel" ? { include_www: opts.www }
    : service === "resend" ? { envs: opts.envs, region: opts.region }
    : { envs: opts.envs, prefix: opts.prefix, create_project: opts.create, vercel_targets: vercel ? opts.targets : [] };

  const waitChecked = async () => {
    for (let i = 0; i < 30; i++) {
      await sleep(3000);
      const c = (await listConnections(fqdn)).connections.find((x) => x.service === service);
      if (c && c.checked_at && (c.status === "active" || c.status === "error")) return c;
    }
    return null;
  };
  const connect = async (e: React.FormEvent) => {
    e.preventDefault(); setMsg(null);
    if (!token.trim()) { setMsg(`Paste the ${p.name} token.`); return; }
    if (service === "vercel" && !ref.trim()) { setMsg("Enter the project's name or ID."); return; }
    setBusy("connect");
    try {
      await connectService(fqdn, service, token.trim(), ref.trim() || undefined);
      setToken("");
      await checkConnection(fqdn, service);
      setMsg(`Connected. Reading your ${p.name} settings, which takes up to a minute.`);
      onChanged();
      const c = await waitChecked();
      setMsg(!c ? `Still reading your ${p.name} settings. Come back in a minute.` : c.status === "error" ? `${p.name} did not accept that token or project. Check them and connect again.` : `Connected to ${p.name}. Preview the changes when you are ready.`);
      onChanged();
    } catch (x) { setMsg(explainRecipe(x)); } finally { setBusy(null); }
  };
  const recheck = async () => {
    setBusy("check"); setMsg(null);
    try { await checkConnection(fqdn, service); const c = await waitChecked(); setMsg(!c ? "Still checking. Come back in a minute." : c.status === "error" ? `${p.name} refused the stored token. Connect again.` : "Checked."); onChanged(); }
    catch (x) { setMsg(explainRecipe(x)); } finally { setBusy(null); }
  };
  const preview = async () => {
    setBusy("plan"); setMsg(null); setPlanned(null);
    try { const out: Planned = await planRecipe(fqdn, r.id, input()); setPlanned({ id: out.application_id, plan: out.plan, notices: out.notices, state: out.state }); }
    catch (x) { setMsg(explainRecipe(x)); } finally { setBusy(null); }
  };
  const run = async () => {
    if (!planned) return;
    setBusy("apply"); setMsg(null);
    try {
      await applyRecipe(fqdn, r.id, planned.id, planned.plan.plan_hash);
      setMsg("Running. This takes a few seconds to a minute.");
      for (let i = 0; i < 40; i++) {
        await sleep(3000);
        const a = await getApplication(planned.id);
        if (a.state === "applied") { setPlanned(null); setMsg(`Done. ${r.title} is set up for ${fqdn}.`); break; }
        if (a.state === "failed") { setPlanned(null); setMsg(explainRecipe(a.failure_code ?? "failed")); break; }
        if (i === 39) setMsg("Still running. Come back in a minute; the result shows here.");
      }
      onChanged();
      const st = useUi.getState(); st.set({ waitingRev: st.waitingRev + 1, groveRev: st.groveRev + 1 });
    } catch (x) { setMsg(explainRecipe(x)); } finally { setBusy(null); }
  };
  const approve = () => {
    if (!planned) return;
    setMsg(null);
    setReq({ type: "dns.sensitive.approve" as StepUpType, target: planned.id, explain: explainRecipe, run: async (actionId) => { await approveApplication(planned.id, actionId); setPlanned({ ...planned, state: "approved" }); setMsg("Approved. Apply it now."); } });
  };
  const off = async () => {
    if (!conn) return;
    setBusy("off"); setMsg(null);
    try { const out = await disconnect(conn.id); setConfirmOff(false); setMsg(`Disconnected from ${p.name}. ${out.records_removed ? `${out.records_removed} DNS record${out.records_removed === 1 ? " it" : "s it"} wrote were removed, and ` : ""}the stored token was destroyed.`); onChanged(); }
    catch (x) { setMsg(explainRecipe(x)); } finally { setBusy(null); }
  };

  const ready = conn?.status === "active" && !!conn.checked_at;
  const toggle = (k: "envs" | "targets", v: string, on: boolean) => setOpts({ ...opts, [k]: on ? [...opts[k], v] : opts[k].filter((x) => x !== v) });
  return (
    <div className="recipe-card" role="group" aria-labelledby={`rc-${r.id}`}>
      <h4 id={`rc-${r.id}`}>{r.title}</h4>
      <p>{r.summary}</p>
      {row && row.state === "applied" && <p className="fineprint">Set up on {ago(row.applied_at)}{row.created_by.kind !== "you" && row.created_by.name ? ` by your token "${row.created_by.name}"` : ""}.</p>}
      {!conn || conn.status === "ended" ? (
        <form className="form-grid" onSubmit={(e) => void connect(e)} aria-label={`Connect ${p.name}`}>
          <p className="fineprint">{p.help} <a href={p.link} target="_blank" rel="noreferrer noopener">Open {p.name}</a>. We keep it encrypted, use it only to run and check this recipe, and destroy it when you disconnect.</p>
          <label>{p.name} token<input className="text-input" type="password" autoComplete="off" spellCheck={false} value={token} onChange={(e) => setToken(e.target.value)} /></label>
          {p.ref && <label>{p.ref}<input className="text-input" autoComplete="off" spellCheck={false} value={ref} onChange={(e) => setRef(e.target.value)} />{p.refHint && <span className="fineprint">{p.refHint}</span>}</label>}
          <div className="row-actions"><button type="submit" className="btn secondary" disabled={!!busy}>{busy === "connect" ? "Connecting." : `Connect ${p.name}`}</button></div>
        </form>
      ) : (
        <>
          <p className="fineprint">{conn.status === "error" ? `${p.name} refused the stored token when we last checked (${ago(conn.checked_at)}).` : conn.checked_at ? `Connected to ${p.name}; checked ${ago(conn.checked_at)}.` : `Connected to ${p.name}; reading its settings.`}</p>
          {ready && !planned && (
            <div className="form-grid">
              {service === "vercel" && <label className="check"><input type="checkbox" checked={opts.www} onChange={(e) => setOpts({ ...opts, www: e.target.checked })} /> <span>Also point www.{fqdn} at the project</span></label>}
              {service !== "vercel" && (
                <fieldset className="choices"><legend>Store the keys for</legend>
                  {[["dev", "Development"], ["preview", "Preview"], ["prod", "Production"]].map(([v, l]) => <label key={v} className="check"><input type="checkbox" checked={opts.envs.includes(v!)} onChange={(e) => toggle("envs", v!, e.target.checked)} /> <span>{l}</span></label>)}
                </fieldset>
              )}
              {service === "resend" && <label>Sending region<select className="text-input" value={opts.region} onChange={(e) => setOpts({ ...opts, region: e.target.value })}>{["us-east-1", "eu-west-1", "sa-east-1", "ap-northeast-1"].map((x) => <option key={x}>{x}</option>)}</select></label>}
              {service === "neon" && (
                <>
                  <label>Prefix for the variable names (optional)<input className="text-input" value={opts.prefix} maxLength={40} onChange={(e) => setOpts({ ...opts, prefix: e.target.value.toUpperCase() })} /></label>
                  <label className="check"><input type="checkbox" checked={opts.create} onChange={(e) => setOpts({ ...opts, create: e.target.checked })} /> <span>Create a new Neon project for this name</span></label>
                  {vercel && (
                    <fieldset className="choices"><legend>Also set them in Vercel for</legend>
                      {[["production", "Production"], ["preview", "Preview"], ["development", "Development"]].map(([v, l]) => <label key={v} className="check"><input type="checkbox" checked={opts.targets.includes(v!)} onChange={(e) => toggle("targets", v!, e.target.checked)} /> <span>{l}</span></label>)}
                    </fieldset>
                  )}
                </>
              )}
              <div className="row-actions"><button type="button" className="btn primary" disabled={!!busy || (service !== "vercel" && opts.envs.length === 0)} onClick={() => void preview()}>{busy === "plan" ? "Preparing." : "Preview the changes"}</button></div>
            </div>
          )}
          {planned && (
            <>
              <PlanBox plan={planned.plan} notices={planned.notices} />
              <div className="row-actions">
                {planned.plan.needs_approval && planned.state !== "approved"
                  ? <button type="button" className="btn primary" disabled={!!busy || !!req} onClick={approve}>Approve with passkey</button>
                  : <button type="button" className="btn primary" disabled={!!busy} onClick={() => void run()}>{busy === "apply" ? "Running." : "Apply"}</button>}
                <button type="button" className="btn secondary" disabled={busy === "apply"} onClick={() => { setPlanned(null); setReq(null); }}>Cancel</button>
              </div>
              {req && <StepUp req={req} onDone={() => setReq(null)} />}
            </>
          )}
          <div className="row-actions">
            {conn.status !== "ended" && <button type="button" className="btn secondary small" disabled={!!busy} onClick={() => void recheck()}>Check again</button>}
            {confirmOff
              ? <><button type="button" className="btn primary small" disabled={!!busy} onClick={() => void off()}>Yes, disconnect</button><button type="button" className="btn secondary small" onClick={() => setConfirmOff(false)}>Keep it</button></>
              : <button type="button" className="btn secondary small" disabled={!!busy} onClick={() => setConfirmOff(true)}>Disconnect {p.name}</button>}
          </div>
          {confirmOff && <p className="warn">Disconnecting removes the DNS records its recipes wrote (only those still exactly as written) and destroys the stored token. Keys already stored in your Nest stay.</p>}
        </>
      )}
      {msg && <p role="status" className="notice">{msg}</p>}
    </div>
  );
}

/**
 * The Connect tab: the recipes (PLAN 4.5 Recipes and Connections) for one name, in the owner's hands. Each recipe shows its provider
 * connection, a preview of exactly what it will change, the passkey when the plan needs it, and the run. Plans an assistant made wait
 * here for the passkey. Lazy chunk.
 */
export default function ConnectTab({ d, reloadAll }: { d: DomainDetail; reloadAll: () => void }) {
  const [recipes, setRecipes] = useState<RecipeInfo[] | null>(null);
  const [conns, setConns] = useState<ConnectionView[]>([]);
  const [findings, setFindings] = useState<Finding[]>([]);
  const [rows, setRows] = useState<ApplicationRow[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [reviewing, setReviewing] = useState<ApplicationRow | null>(null);
  const load = useCallback(async () => {
    try {
      const [r, c, a] = await Promise.all([listRecipes(), listConnections(d.fqdn), listApplications(d.fqdn)]);
      setRecipes(r); setConns(c.connections); setFindings(c.findings); setRows(a); setErr(null);
    } catch (e) { setErr(explainRecipe(e)); }
  }, [d.fqdn]);
  useEffect(() => { void load(); }, [load]);
  const changed = () => { void load(); reloadAll(); };
  // A plan from a token that still works (a paused or revoked token leaves nothing waiting, as with its requests).
  const waiting = rows.filter((a) => a.state === "planned" && a.needs_approval && a.created_by.kind !== "you" && a.created_by.live === true);

  return (
    <div>
      <p>Point {d.fqdn} at your hosting, mail and database. Mosshatch asks the provider what to set, writes the DNS records and stores the keys your app needs in the Nest. You see every change before it happens, and anything sensitive waits for your passkey.</p>
      {!d.dns_hosted_here && <p className="notice">This name uses other nameservers, so recipes that write DNS records cannot run until it uses ours. Postgres on Neon still works.</p>}
      {err && <p role="alert" className="notice">{err}</p>}
      {waiting.length > 0 && (
        <div className="banner" role="status">
          {waiting.map((a) => (
            <p key={a.id}>Your token "{a.created_by.name ?? "a token"}" planned {recipes?.find((r) => r.id === a.recipe)?.title ?? a.recipe} for this name. <button type="button" className="btn secondary small" onClick={() => setReviewing(a)}>Review</button></p>
          ))}
        </div>
      )}
      {findings.length > 0 && <p className="warn" role="status">A record points at a provider that no longer has it: {findings.map((f) => f.host).join(", ")}. Run the recipe again, or remove the record on the DNS tab.</p>}
      {!recipes && !err && <p role="status">Loading.</p>}
      {recipes?.map((r) => (
        <RecipeCard key={r.id} d={d} r={r} conns={conns} onChanged={changed}
          row={rows.find((a) => a.recipe === r.id && a.state === "applied")}
          waitingId={reviewing?.recipe === r.id ? reviewing.id : null} />
      ))}
    </div>
  );
}
