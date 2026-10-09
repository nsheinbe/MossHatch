import "./DnsTab.css";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  addRecords, changeDs, deleteRecord, dnsApprovalFromError, previewNameservers, draftContact, explainDomain, explainRollback, getContactStart, getDns, getDs, getSnapshots, getVerification, rollback,
  sendVerification, submitContact, verifyRegistrant, type NameserverPlan, type ContactFields, type DnsRecordView, type DnsView, type DomainDetail, type DsView, type Security, type Snapshot,
} from "../lib/domains";
import { StepUp, type StepUpRequest } from "./StepUp";
import { dnsReviewText } from "../lib/dns-display";

const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"] as const;
const SENSITIVE_WORD: Record<string, string> = { apex: "the domain itself", underscore_label: "a verification or mail-security name", www: "the www address", wildcard: "a wildcard", mail_host: "a mail setup name", type: "a mail, delegation or service record", txt_value: "a verification or mail-security value", unverified_txt: "an unverified ownership or service token", production_host: "a production service", service_dependency: "a mail or service dependency", deletion: "a record deletion" };
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";

/** A hint only. The server classifies every record and is the one that counts; this warns before the click. */
function looksSensitive(type: string, name: string): boolean {
  const n = name.trim().toLowerCase();
  return ["MX", "SRV"].includes(type) || n === "" || n === "@" || n === "www" || n.startsWith("_") || n.includes("*") || ["autoconfig", "autodiscover", "mta-sts"].includes(n.split(".")[0]!);
}

export function DnsTab({ d, sec, reloadAll }: { d: DomainDetail; sec: Security | null; reloadAll: () => void }) {
  const f = d.fqdn;
  const [dns, setDns] = useState<DnsView | null>(null);
  const [readErrors, setReadErrors] = useState<{ dns?: string; snapshots?: string; ds?: string }>({});
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [ds, setDs] = useState<DsView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [rec, setRec] = useState({ type: "A", name: "", value: "", priority: "", weight: "", port: "", ttl: "3600" });
  const [ns, setNs] = useState(d.nameservers.join("\n"));
  const [approvalDiff, setApprovalDiff] = useState<ReturnType<typeof dnsApprovalFromError>>(null);
  const [nsPlan, setNsPlan] = useState<NameserverPlan | null>(null);
  const running = useRef(false);
  const [dsForm, setDsForm] = useState({ keyTag: "", algorithm: "13", digestType: "2", digest: "" });

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.allSettled([getDns(f), getSnapshots(f), getDs(f)]);
    setReadErrors({ ...(a.status === "rejected" ? { dns: explainDomain(a.reason) } : {}), ...(b.status === "rejected" ? { snapshots: explainDomain(b.reason) } : {}), ...(c.status === "rejected" ? { ds: explainDomain(c.reason) } : {}) });
    if (a.status === "fulfilled") setDns(a.value); else setMsg(explainDomain(a.reason));
    if (b.status === "fulfilled") setSnaps(b.value);
    if (c.status === "fulfilled") setDs(c.value);
  }, [f]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: (actionId?: string) => Promise<string | void>, explain: (e: unknown) => string = explainDomain) => {
    if (running.current || req) return;
    running.current = true;
    setBusy(true); setMsg(null);
    try { const m = await fn(); if (m) setMsg(m); await load(); }
    catch (e) {
      const approval = dnsApprovalFromError(e);
      if (approval) { setApprovalDiff(approval); setReq({ type: "dns.sensitive.approve", target: approval.target, input: approval.input, explain,
        run: async (id) => { const m = await fn(id); if (m) setMsg(m); await load(); },
      }); }
      else setMsg(explain(e));
    } finally { running.current = false; setBusy(false); }
  };
  const changed = (r: { changed: boolean; sensitive?: boolean }, _what: string) =>
    !r.changed ? "Nothing changed." : "Change accepted; the provider read-back matches. Authoritative visibility has not been checked. Propagation has not been sampled.";

  const add = () => act(async (actionId) => {
    const r: Record<string, unknown> = { type: rec.type, name: rec.name.trim() || "@", value: rec.value };
    if (rec.priority !== "") r.priority = Number(rec.priority);
    if (rec.weight !== "") r.weight = Number(rec.weight);
    if (rec.port !== "") r.port = Number(rec.port);
    if (rec.ttl !== "") r.ttl = Number(rec.ttl);
    const out = await addRecords(f, [r as never], actionId);
    setRec({ type: rec.type, name: "", value: "", priority: "", weight: "", port: "", ttl: "3600" });
    return changed(out, "Record added.");
  });

  const editable = dns?.hosted && !dns.read_only && !readErrors.dns;
  return (
    <div className="dns-panel">
      {msg && <p role="status" className="notice">{msg}</p>}

      <div className="section" role="group" aria-labelledby="rec-h">
        <h3 id="rec-h">Records</h3>
        {readErrors.dns ? <p role="alert">Records could not be refreshed. {readErrors.dns} <button type="button" className="btn secondary small" onClick={() => void load()}>Retry records</button></p> : !dns && <p role="status">Loading the records.</p>}
        {dns && !dns.hosted && (
          <>
            <p>{dns.message ?? "DNS for this name is hosted elsewhere, so it cannot be edited here."}</p>
            {dns.nameservers && <ul className="plain">{dns.nameservers.map((n) => <li key={n}>{n}</li>)}</ul>}
          </>
        )}
        {dns?.hosted && (
          <>
            <p className="notice">Sensitive changes and deletions need approval with your passkey. Records and their TTL are included in the reviewed plan.</p>
            {dns.records.length === 0 ? <p>There are no records yet.</p> : (
              <ul className="dns-records" aria-label={`DNS records for ${f}`}>
                {dns.records.map((r: DnsRecordView) => (
                  <li key={r.id} className="dns-record">
                    <div className="dns-record-heading"><span className="dns-record-identity"><span className="dns-type">{r.type}</span><code>{r.name}</code></span><span className="dns-ttl">TTL {r.ttl !== undefined ? `${r.ttl}s` : 'default'}</span></div>
                    <code className="dns-value">{r.value}</code>
                    {(r.priority !== undefined || r.weight !== undefined || r.port !== undefined) && <p className="dns-record-meta">{r.priority !== undefined && <span>Priority {r.priority}</span>}{r.weight !== undefined && <span>Weight {r.weight}</span>}{r.port !== undefined && <span>Port {r.port}</span>}</p>}
                    <div className="dns-record-footer"><span className={r.sensitive ? 'warn' : 'dns-record-meta'}>{r.sensitive ? `Sensitive: ${r.reasons.map((x) => SENSITIVE_WORD[x] ?? x).join(', ')}` : r.editable === false ? 'Preserved; editing unavailable' : 'Standard record'}{r.editable === false && <span className="dns-preserved">Preserved; editing unavailable</span>}</span>
                      <button type="button" className="btn secondary small" disabled={busy || !!req || !editable || r.editable === false} aria-label={`Delete the ${r.type} record for ${r.name}`} onClick={() => void act(async (id) => changed(await deleteRecord(f, r.id, id), "Record deleted."))}>Delete</button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
            <form onSubmit={(e) => { e.preventDefault(); void add(); }} aria-labelledby="add-h" className="form-grid dns-record-form">
              <h4 id="add-h">Add a record</h4>
              <label>Type
                <select className="text-input" value={rec.type} onChange={(e) => setRec({ ...rec, type: e.target.value })}>{TYPES.map((t) => <option key={t}>{t}</option>)}</select>
              </label>
              <label>Name, or @ for the domain itself
                <input className="text-input" value={rec.name} onChange={(e) => setRec({ ...rec, name: e.target.value })} autoComplete="off" />
              </label>
              <label>Value
                <input className="text-input" required value={rec.value} onChange={(e) => setRec({ ...rec, value: e.target.value })} autoComplete="off" />
              </label>
              {(rec.type === "MX" || rec.type === "SRV") && <label>Priority<input className="text-input" inputMode="numeric" required value={rec.priority} onChange={(e) => setRec({ ...rec, priority: e.target.value })} /></label>}
              {rec.type === "SRV" && <label>Weight<input className="text-input" inputMode="numeric" required value={rec.weight} onChange={(e) => setRec({ ...rec, weight: e.target.value })} /></label>}
              {rec.type === "SRV" && <label>Port<input className="text-input" inputMode="numeric" required value={rec.port} onChange={(e) => setRec({ ...rec, port: e.target.value })} /></label>}
              <label>TTL, in seconds<input className="text-input" type="number" min="0" max="2147483647" required value={rec.ttl} onChange={(e) => setRec({ ...rec, ttl: e.target.value })} /></label>
              {looksSensitive(rec.type, rec.name) && <p className="warn" role="status">This looks like a sensitive record. It can change where mail goes or who can get a certificate. Review the exact change, then approve it with your passkey.</p>}
              <div className="row-actions"><button type="submit" className="btn primary" disabled={busy || !!req || !editable}>Add record</button></div>
            </form>
          </>
        )}
      </div>

      {editable && (
        <div className="section" role="group" aria-labelledby="hist-h">
          <h3 id="hist-h">History</h3>
          <p className="notice">Before each change we keep a copy of the records for 30 days. Rollback requires a new review and may be blocked while an uncertain write is reconciled. It cannot undo lost mail or answers already cached elsewhere.</p>
          {readErrors.snapshots ? <p role="alert">History could not be refreshed. {readErrors.snapshots}</p> : snaps.length === 0 ? <p>No changes yet.</p> : (
            <ul className="plain">
              {snaps.map((s) => (
                <li key={s.id}>
                  <span>{when(s.taken_at)}: {s.reason === "pre_rollback" ? "before a roll back" : "before a change"}, {s.added} added, {s.removed} removed{s.sensitive ? `, ${s.sensitive} sensitive` : ""}{s.rolled_back_at ? ", rolled back" : ""}. </span>
                  <button type="button" className="btn secondary small" disabled={busy || !!req} aria-label={`Roll back to before the change of ${when(s.taken_at)}`} onClick={() => void act(async (id) => changed(await rollback(f, s.id, id), "Rolled back."), explainRollback)}>Roll back</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="section dns-delegation" role="group" aria-labelledby="ns-h">
        <h3 id="ns-h">Nameservers</h3>
        <p>{d.dns_hosted_here ? "Records for this name are managed here." : "Records for this name are managed by another DNS provider."}</p>
        <p>Changing delegation affects every service on this domain. Source records stay intact. Another DNS provider needs separate authorization and a complete record inventory.</p>
        <form onSubmit={(e) => { e.preventDefault(); void act(async () => { setNsPlan(await previewNameservers(f, ns.split(/[\s,]+/).filter(Boolean))); }); }}>
          <label htmlFor="ns-box">Nameservers <span className="dns-field-hint">One hostname per line</span></label>
          <textarea id="ns-box" className="text-input area" rows={3} value={ns} onChange={(e) => { setNs(e.target.value); setNsPlan(null); }} />
          <div className="row-actions"><button type="submit" className="btn secondary" disabled={busy || !!req}>Review nameserver request</button></div>
        </form>
        {nsPlan && <div role="status" className="notice"><p>Current: {nsPlan.before.join(", ")}. Requested: {nsPlan.nameservers.join(", ")}.</p><p>Execution is blocked until destination authorization, complete inventory and DNSSEC transition checks are supported. No nameservers or source records changed.</p></div>}
      </div>

      <div className="section" role="group" aria-labelledby="ds-h">
        <h3 id="ds-h">DNSSEC</h3>
        {readErrors.ds ? <p role="alert">DNSSEC status could not be refreshed. {readErrors.ds} <button type="button" className="btn secondary small" onClick={() => void load()}>Retry DNSSEC</button></p> : !ds ? <p role="status">Loading DNSSEC status.</p> : !ds.supported ? <p>DNSSEC is not supported for this extension.</p> : (
          <>
            <p className="notice">{ds.note}</p>
            {ds.records.length === 0 ? <p>No DNSSEC records are set.</p> : (
              <ul className="plain">{ds.records.map((r) => (
                <li key={`${r.keyTag}${r.digest}`}><span>Key tag {r.keyTag}, algorithm {r.algorithm}, digest type {r.digestType}, <code>{r.digest.slice(0, 16)}…</code> </span>
                  <button type="button" className="btn secondary small" disabled={!!req || busy || ds.remove_supported !== true || ds.changes_supported !== true} aria-label={`Remove the DNSSEC record with key tag ${r.keyTag}`} onClick={() => { setMsg(null); setReq({ type: "domain.nameservers.change", target: f, input: { kind: "ds_remove", ds: r }, run: async (id) => { await changeDs(f, id); setMsg("DNSSEC record removed."); reloadAll(); } }); }}>Remove</button></li>
              ))}</ul>
            )}
            {ds.changes_supported === true && ds.add_mode === "ds" && <form className="form-grid" aria-labelledby="dsadd-h" onSubmit={(e) => { e.preventDefault(); setMsg(null); setReq({ type: "domain.nameservers.change", target: f, input: { kind: "ds_add", ds: { keyTag: Number(dsForm.keyTag), algorithm: Number(dsForm.algorithm), digestType: Number(dsForm.digestType), digest: dsForm.digest.trim() } }, run: async (id) => { await changeDs(f, id); setMsg("DNSSEC record added."); reloadAll(); } }); }}>
              <h4 id="dsadd-h">Add a DNSSEC record</h4>
              <label>Key tag<input className="text-input" inputMode="numeric" required value={dsForm.keyTag} onChange={(e) => setDsForm({ ...dsForm, keyTag: e.target.value })} /></label>
              <label>Algorithm<input className="text-input" inputMode="numeric" required value={dsForm.algorithm} onChange={(e) => setDsForm({ ...dsForm, algorithm: e.target.value })} /></label>
              <label>Digest type<input className="text-input" inputMode="numeric" required value={dsForm.digestType} onChange={(e) => setDsForm({ ...dsForm, digestType: e.target.value })} /></label>
              <label>Digest, in hex<input className="text-input" required value={dsForm.digest} onChange={(e) => setDsForm({ ...dsForm, digest: e.target.value })} autoComplete="off" /></label>
              <div className="row-actions"><button type="submit" className="btn secondary" disabled={!!req}>Add DNSSEC record</button></div>
            </form>}
          </>
        )}
        {req?.type === "domain.nameservers.change" && (req.input as { kind?: string })?.kind !== "nameservers" && <StepUp key="ds" req={req} onDone={() => { setReq(null); void load(); }} />}
      </div>

      {req?.type === "dns.sensitive.approve" && <section className="section dns-review" aria-label="Review exact DNS change">
        <h3>Review exact changes</h3>
        <p>Exact text is quoted; invisible characters are shown as escapes. Values are not shortened or normalized.</p>
        {approvalDiff && ([['Add', approvalDiff.added], ['Remove', approvalDiff.removed]] as const).map(([label, records]) => <div key={label}><h4>{label}</h4>{records.length ? <ul className="plain">{records.map((r, i) => <li key={i}><code style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{dnsReviewText(r.type)} {dnsReviewText(r.name || '@')} {dnsReviewText(r.value)}</code>{r.priority !== undefined && <span> · Priority {r.priority}</span>}{r.weight !== undefined && <span> · Weight {r.weight}</span>}{r.port !== undefined && <span> · Port {r.port}</span>} · TTL {r.ttl === undefined ? 'not recorded' : `${r.ttl} seconds`}</li>)}</ul> : <p>None.</p>}</div>)}
        <p>Approval covers exactly these values and TTL against the reviewed state. Cached answers or mail already lost cannot be undone by rollback.</p>
        <StepUp req={req} onDone={() => { setReq(null); setApprovalDiff(null); void load(); }} />
      </section>}

      <ContactSection f={f} sec={sec} reloadAll={reloadAll} />
    </div>
  );
}

function ContactSection({ f, sec, reloadAll }: { f: string; sec: Security | null; reloadAll: () => void }) {
  const [ver, setVer] = useState<{ state: string; days_left: number } | null>(null);
  const [code, setCode] = useState("");
  const [form, setForm] = useState<ContactFields>({ name: "", email: "", phone: "", street: "", city: "", region: "", postalCode: "", country: "US" });
  const [warn, setWarn] = useState<string[]>([]);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const loadVer = useCallback(() => { void getVerification(f).then((v) => setVer(v.verification)).catch(() => setVer(null)); }, [f]);
  useEffect(() => { loadVer(); }, [loadVer]);
  useEffect(() => { if (open) void getContactStart(f).then((c) => { if (c.current) setForm((x) => ({ ...x, name: c.current!.name, email: c.current!.email, country: c.current!.country })); }).catch(() => undefined); }, [open, f]);
  const run = async (fn: () => Promise<string | void>) => { setBusy(true); setMsg(null); try { const m = await fn(); if (m) setMsg(m); } catch (e) { setMsg(explainDomain(e)); } finally { setBusy(false); } };
  const set = (k: keyof ContactFields) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const pending = ver && ver.state !== "verified";

  return (
    <div className="section" role="group" aria-labelledby="ct-h">
      <h3 id="ct-h">Contact and registrant</h3>
      {pending && (
        <div className="banner" role="status">
          <p>Verify the registrant email within {ver!.days_left} {ver!.days_left === 1 ? "day" : "days"}, or the registry puts the name on hold. We send an eight-digit code to that address.</p>
          <div className="row-actions"><button type="button" className="btn secondary" disabled={busy} onClick={() => void run(async () => { await sendVerification(f); return "If the address can be reached, a code is on its way."; })}>Email me a code</button></div>
          <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await verifyRegistrant(f, code.trim()); setCode(""); loadVer(); reloadAll(); return "The registrant email is verified."; }); }}>
            <label htmlFor="rv-code">Eight-digit code</label>
            <input id="rv-code" className="text-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
            <div className="row-actions"><button type="submit" className="btn secondary" disabled={busy}>Verify</button></div>
          </form>
        </div>
      )}
      {sec?.contact_change && <p className="notice" role="status">A contact change is waiting for approval by email{sec.contact_change.approval_deadline_at ? ` until ${new Date(sec.contact_change.approval_deadline_at).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}` : ""}.</p>}
      {msg && <p role="status" className="notice">{msg}</p>}
      {!open ? <div className="row-actions"><button type="button" className="btn secondary" onClick={() => setOpen(true)}>Change contact details</button></div> : (
        <form className="form-grid" aria-label="New contact details" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          const dr = await draftContact(f, form);
          setWarn(dr.warnings.map((w) => w.message));
          setReq({ type: "domain.contact.change", target: dr.id, run: async (id) => { const r = await submitContact(f, id); setOpen(false); setWarn([]); setMsg(r.status === "applied" ? "Contact details updated." : "Sent. Both the current and the new registrant must approve it by email."); loadVer(); reloadAll(); } });
        }); }}>
          <label>Full name<input className="text-input" required value={form.name} onChange={set("name")} autoComplete="off" /></label>
          <label>Email<input className="text-input" type="email" required value={form.email} onChange={set("email")} autoComplete="off" /></label>
          <label>Phone, like +1.5555550100<input className="text-input" required value={form.phone} onChange={set("phone")} autoComplete="off" /></label>
          <label>Street address<input className="text-input" required value={form.street} onChange={set("street")} autoComplete="off" /></label>
          <label>City<input className="text-input" required value={form.city} onChange={set("city")} autoComplete="off" /></label>
          <label>State or region<input className="text-input" required value={form.region} onChange={set("region")} autoComplete="off" /></label>
          <label>Postal code<input className="text-input" required value={form.postalCode} onChange={set("postalCode")} autoComplete="off" /></label>
          <label>Country, two letters<input className="text-input" required maxLength={2} value={form.country} onChange={set("country")} autoComplete="off" /></label>
          {warn.map((w) => <p key={w} className="warn" role="status">{w}</p>)}
          <div className="row-actions"><button type="submit" className="btn secondary" disabled={busy || !!req}>Review the change</button><button type="button" className="btn secondary" onClick={() => { setOpen(false); setReq(null); setWarn([]); }}>Cancel</button></div>
        </form>
      )}
      {req?.type === "domain.contact.change" && <StepUp key={req.target} req={req} onDone={() => setReq(null)} />}
    </div>
  );
}
