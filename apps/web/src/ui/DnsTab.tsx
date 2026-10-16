import { useCallback, useEffect, useState } from "react";
import { normalizePhone } from "@mosshatch/core";
import { sessionEnded } from "../lib/session";
import { PHONE_HINT, PHONE_PROBLEM } from "./ContactForm";
import {
  addRecords, changeDs, changeNameservers, deleteRecord, draftContact, explainDomain, explainRollback, getContactStart, getDns, getDs, getSnapshots, getVerification, rollback,
  sendVerification, submitContact, verifyRegistrant, type ContactFields, type DnsRecordView, type DnsView, type DomainDetail, type DsRecordView, type DsView, type Security, type Snapshot, type VerificationState,
} from "../lib/domains";
import { StepUp, type StepUpRequest } from "./StepUp";

const TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "SRV"] as const;
const SENSITIVE_WORD: Record<string, string> = { apex: "the domain itself", underscore_label: "a verification or mail-security name", www: "the www address", mail_host: "a mail setup name", type: "a mail, delegation or service record", txt_value: "a verification or mail-security value", wildcard: "a wildcard" };
/** Local time with the zone named, so "4:59 PM UTC" never reads as an afternoon change to someone whose morning it was. */
const when = (iso: string) => new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" });

/** A hint only. The server classifies every record and is the one that counts; this warns before the click. */
function looksSensitive(type: string, name: string): boolean {
  const n = name.trim().toLowerCase();
  return ["MX", "SRV"].includes(type) || n === "" || n === "@" || n === "www" || n.startsWith("_") || n.includes("*") || ["autoconfig", "autodiscover", "mta-sts"].includes(n.split(".")[0]!);
}

/** "1 record added (1 sensitive)", "2 removed", "a roll back": what a History line undoes. */
function describeSnapshot(s: Snapshot): string {
  const parts = [s.added ? `${s.added} ${s.added === 1 ? "record" : "records"} added` : "", s.removed ? `${s.removed} removed` : ""].filter(Boolean);
  const what = s.reason === "pre_rollback" ? "a roll back" : parts.length ? parts.join(", ") : "a change";
  return `${what}${s.sensitive ? ` (${s.sensitive} sensitive)` : ""}${s.rolled_back_at ? ", since rolled back" : ""}`;
}

// ---- DNSSEC words and checks (the server checks again; these save a passkey prompt) -------------------------------------------------------
const ALGORITHMS: [number, string][] = [[13, "ECDSA P-256 with SHA-256"], [8, "RSA with SHA-256"], [15, "Ed25519"], [14, "ECDSA P-384 with SHA-384"], [16, "Ed448"], [10, "RSA with SHA-512"], [7, "RSA with SHA-1 (NSEC3)"], [5, "RSA with SHA-1"]];
const algorithmName = (n: number) => { const hit = ALGORITHMS.find(([k]) => k === n); return hit ? `${n} (${hit[1]})` : String(n); };
const DIGEST_TYPES: [number, string, number][] = [[2, "SHA-256", 64], [4, "SHA-384", 96], [1, "SHA-1", 40]];
function checkDs(f: { keyTag: string; digestType: string; digest: string }): string | null {
  if (!/^\d{1,5}$/.test(f.keyTag.trim()) || Number(f.keyTag) > 65535) return "The key tag is a number from 0 to 65535.";
  const hex = f.digest.replace(/\s+/g, "");
  if (!/^[0-9a-fA-F]+$/.test(hex)) return "The digest is hexadecimal: digits and the letters a to f.";
  const dt = DIGEST_TYPES.find(([k]) => k === Number(f.digestType));
  if (dt && hex.length !== dt[2]) return `A ${dt[1]} digest is ${dt[2]} characters long; this one is ${hex.length}.`;
  return null;
}
/** A pasted DNSKEY record line ("257 3 13 AwEAA...") fills the flags and the algorithm; a bare key is taken as it is. */
function parseDnskey(text: string, flags: string, algorithm: string): { flags: number; algorithm: number; publicKey: string } {
  const parts = text.trim().split(/\s+/);
  if (parts.length >= 4 && /^\d+$/.test(parts[0]!) && /^\d+$/.test(parts[1]!) && /^\d+$/.test(parts[2]!)) return { flags: Number(parts[0]), algorithm: Number(parts[2]), publicKey: parts.slice(3).join("") };
  return { flags: Number(flags), algorithm: Number(algorithm), publicKey: parts.join("") };
}
function checkDnskey(k: { flags: number; algorithm: number; publicKey: string }): string | null {
  if (k.flags !== 256 && k.flags !== 257) return "The flags are 257 for a key-signing key or 256 for a zone-signing key.";
  if (!Number.isInteger(k.algorithm) || k.algorithm < 1 || k.algorithm > 255) return "The algorithm is a number, such as 13.";
  if (k.publicKey.length < 20 || !/^[A-Za-z0-9+/]+=*$/.test(k.publicKey)) return "The public key is the long base64 text your DNS provider shows for the zone.";
  return null;
}

export function DnsTab({ d, sec, reloadAll }: { d: DomainDetail; sec: Security | null; reloadAll: () => void }) {
  const f = d.fqdn;
  const [dns, setDns] = useState<DnsView | null>(null);
  const [snaps, setSnaps] = useState<Snapshot[]>([]);
  const [ds, setDs] = useState<DsView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [rec, setRec] = useState({ type: "A", name: "", value: "", priority: "", weight: "", port: "" });
  const [ns, setNs] = useState(d.nameservers.join("\n"));
  const [signed, setSigned] = useState(false);
  const [dsForm, setDsForm] = useState({ keyTag: "", algorithm: "13", digestType: "2", digest: "" });
  const [keyForm, setKeyForm] = useState({ flags: "257", algorithm: "13", publicKey: "" });

  const load = useCallback(async () => {
    const [a, b, c] = await Promise.allSettled([getDns(f), getSnapshots(f), getDs(f)]);
    if (a.status === "fulfilled") setDns(a.value); else setMsg(explainDomain(a.reason));
    if (b.status === "fulfilled") setSnaps(b.value);
    if (c.status === "fulfilled") setDs(c.value);
  }, [f]);
  useEffect(() => { void load(); }, [load]);

  const act = async (fn: () => Promise<string | void>, explain: (e: unknown) => string = explainDomain) => {
    setBusy(true); setMsg(null);
    try { const m = await fn(); if (m) setMsg(m); await load(); } catch (e) { setMsg(explain(e)); } finally { setBusy(false); }
  };
  const changed = (r: { changed: boolean; sensitive?: boolean }, what: string) =>
    !r.changed ? "Nothing changed." : `${what}${r.sensitive ? " This touched a sensitive record, so we emailed you. Roll it back under History if it was not you." : ""}`;

  const add = () => act(async () => {
    const r: Record<string, unknown> = { type: rec.type, name: rec.name.trim() || "@", value: rec.value };
    if (rec.priority !== "") r.priority = Number(rec.priority);
    if (rec.weight !== "") r.weight = Number(rec.weight);
    if (rec.port !== "") r.port = Number(rec.port);
    const out = await addRecords(f, [r as never]);
    setRec({ type: rec.type, name: "", value: "", priority: "", weight: "", port: "" });
    return changed(out, "Record added.");
  });

  const editable = dns?.hosted && !dns.read_only;
  // The warning waits until something is typed: an empty form is the domain itself, and shouting before a keystroke taught nobody anything.
  const warnSensitive = (rec.name !== "" || rec.value !== "" || rec.type === "MX" || rec.type === "SRV") && looksSensitive(rec.type, rec.name);
  const dsHere = (ds?.records.length ?? 0) > 0 || d.ds_present;
  const managed = ds?.auto_signed === true;
  const keyInput = ds?.key_input ?? "ds";
  // Our nameservers add their own key on a registrar that takes keys, and while that key stands, any other is dropped: no form then.
  const canAddKey = !!ds?.supported && !managed && !(ds?.hosted_here && keyInput === "dnskey");
  const dsChange = (input: { kind: "ds_add" | "ds_remove"; ds?: DsRecordView; dnskey?: { flags: number; algorithm: number; publicKey: string } }, done: string) => {
    setMsg(null);
    setReq({ type: "domain.nameservers.change", target: f, input, run: async (id) => { await changeDs(f, id); setMsg(done); reloadAll(); } });
  };
  const submitDs = (e: React.FormEvent) => {
    e.preventDefault();
    const problem = checkDs(dsForm); if (problem) { setMsg(problem); return; }
    dsChange({ kind: "ds_add", ds: { keyTag: Number(dsForm.keyTag), algorithm: Number(dsForm.algorithm), digestType: Number(dsForm.digestType), digest: dsForm.digest.replace(/\s+/g, "").toLowerCase() } }, "DNSSEC record added.");
  };
  const submitKey = (e: React.FormEvent) => {
    e.preventDefault();
    const key = parseDnskey(keyForm.publicKey, keyForm.flags, keyForm.algorithm);
    const problem = checkDnskey(key); if (problem) { setMsg(problem); return; }
    dsChange({ kind: "ds_add", dnskey: key }, "DNSSEC key added. The registry publishes the matching record.");
  };

  return (
    <div>
      {msg && <p role="status" className="notice">{msg}</p>}

      <div className="section" role="group" aria-labelledby="rec-h">
        <h3 id="rec-h">Records</h3>
        {!dns && <p>Loading the records.</p>}
        {dns && !dns.hosted && (
          <>
            <p>{dns.message ?? "DNS for this name is hosted elsewhere, so it cannot be edited here."}</p>
            {dns.nameservers && <ul className="plain">{dns.nameservers.map((n) => <li key={n}>{n}</li>)}</ul>}
          </>
        )}
        {dns?.hosted && (
          <>
            <p className="notice">Records marked sensitive control mail, certificates or where the name points. When one changes, we email you, and you can roll the change back under History.</p>
            {dns.records.length === 0 ? <p>There are no records yet.</p> : (
              <div className="table-wrap">
                {/* The roles are explicit so the stacked layout in the side panel keeps this a table for assistive technology. */}
                <table className="data records" role="table">
                  <caption className="sr-only">DNS records for {f}</caption>
                  <thead className="sr-only" role="rowgroup"><tr role="row"><th role="columnheader" scope="col">Type</th><th role="columnheader" scope="col">Name</th><th role="columnheader" scope="col">Value</th><th role="columnheader" scope="col">Note</th><th role="columnheader" scope="col"><span className="sr-only">Actions</span></th></tr></thead>
                  <tbody role="rowgroup">
                    {dns.records.map((r: DnsRecordView) => (
                      <tr key={r.id} role="row">
                        <td role="cell" className="rec-type">{r.type}</td><td role="cell" className="rec-name">{r.name}</td>
                        <td role="cell" className="val rec-val">{r.priority !== undefined ? `${r.priority} ` : ""}{r.weight !== undefined ? `${r.weight} ` : ""}{r.port !== undefined ? `${r.port} ` : ""}{r.value}</td>
                        <td role="cell" className="rec-note">{r.sensitive ? <span className="warn">Sensitive: {r.reasons.map((x) => SENSITIVE_WORD[x] ?? x).join(", ")}</span> : ""}</td>
                        <td role="cell" className="rec-act"><button type="button" className="btn secondary small" disabled={busy} aria-label={`Delete the ${r.type} record for ${r.name}`} onClick={() => void act(async () => changed(await deleteRecord(f, r.id), "Record deleted."))}>Delete</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <form onSubmit={(e) => { e.preventDefault(); void add(); }} aria-labelledby="add-h" className="form-grid">
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
              {warnSensitive && <p className="warn" role="status">This looks like a sensitive record. It can change where mail goes or who can get a certificate. We will email you when it is saved.</p>}
              <div className="row-actions"><button type="submit" className="btn primary" disabled={busy}>Add record</button></div>
            </form>
          </>
        )}
      </div>

      {editable && (
        <div className="section" role="group" aria-labelledby="hist-h">
          <h3 id="hist-h">History</h3>
          <p className="notice">Before each change we keep a copy of the records for 30 days. Roll back puts them back as they were.</p>
          {snaps.length === 0 ? <p>No changes yet.</p> : (
            <ul className="plain">
              {snaps.map((s) => (
                <li key={s.id}>
                  <span>{when(s.taken_at)}: {describeSnapshot(s)}. </span>
                  <button type="button" className="btn secondary small" disabled={busy} aria-label={`Roll back to before the change of ${when(s.taken_at)}`} onClick={() => void act(async () => changed(await rollback(f, s.id), "Rolled back."), explainRollback)}>Roll back</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="section" role="group" aria-labelledby="ns-h">
        <h3 id="ns-h">Nameservers</h3>
        <p>{(dns?.hosted ?? d.dns_hosted_here) ? "This name uses our nameservers, so you edit its records here." : "This name uses other nameservers, so its records live there."}</p>
        <form onSubmit={(e) => { e.preventDefault(); setMsg(null); setReq({ type: "domain.nameservers.change", target: f, input: { kind: "nameservers", nameservers: ns.split(/[\s,]+/).filter(Boolean), target_signed: signed }, run: async (id) => { await changeNameservers(f, id); setMsg("Nameservers changed. We emailed you."); reloadAll(); } }); }}>
          <label htmlFor="ns-box">Nameservers, one per line</label>
          <textarea id="ns-box" className="text-input area" rows={3} value={ns} onChange={(e) => setNs(e.target.value)} />
          {dsHere && managed && <p className="notice">This name is signed by our nameservers. To move it elsewhere, turn DNSSEC off below first and wait until the record is gone (it can take a day). If the new nameservers sign the zone, add their key here after the move.</p>}
          {dsHere && !managed && (
            <>
              <label className="check"><input type="checkbox" checked={signed} onChange={(e) => setSigned(e.target.checked)} /> These nameservers serve a DNSSEC-signed zone</label>
              <p className="fineprint">Leave it unticked if the new nameservers do not sign: the change is then refused until the DNSSEC record below is removed, so the name keeps resolving.</p>
            </>
          )}
          <div className="row-actions"><button type="submit" className="btn secondary" disabled={!!req}>Change nameservers</button></div>
        </form>
        {req?.type === "domain.nameservers.change" && (req.input as { kind?: string })?.kind === "nameservers" && <StepUp key="ns" req={req} onDone={() => { setReq(null); void load(); }} />}
      </div>

      <div className="section" role="group" aria-labelledby="ds-h">
        <h3 id="ds-h">DNSSEC</h3>
        {!ds ? <p>Loading.</p> : !ds.supported ? <p>DNSSEC is not supported for this extension.</p> : (
          <>
            <p className="notice">{ds.note}</p>
            {ds.records.length === 0 ? <p>No DNSSEC records are set.</p> : (
              <ul className="plain">{ds.records.map((r) => (
                <li key={`${r.keyTag}${r.digest}`}><span>{r.managed ? "Signed by our nameservers: " : ""}Key tag {r.keyTag}, algorithm {algorithmName(r.algorithm)}, digest type {r.digestType}, <code>{r.digest.slice(0, 16)}…</code> </span>
                  <button type="button" className="btn secondary small" aria-label={`Remove the DNSSEC record with key tag ${r.keyTag}`} onClick={() => dsChange({ kind: "ds_remove", ds: { keyTag: r.keyTag, algorithm: r.algorithm, digestType: r.digestType, digest: r.digest } }, r.managed ? "DNSSEC is being turned off. The registry drops the record within a day." : "DNSSEC record removed.")}>{r.managed ? "Turn DNSSEC off" : "Remove"}</button></li>
              ))}</ul>
            )}
            {canAddKey && keyInput === "dnskey" && (
              <form className="form-grid" aria-labelledby="dsadd-h" onSubmit={submitKey}>
                <h4 id="dsadd-h">Add a DNSSEC key</h4>
                <label>Flags
                  <select className="text-input" value={keyForm.flags} onChange={(e) => setKeyForm({ ...keyForm, flags: e.target.value })}><option value="257">257, a key-signing key (the usual one)</option><option value="256">256, a zone-signing key</option></select>
                </label>
                <label>Algorithm
                  <select className="text-input" value={keyForm.algorithm} onChange={(e) => setKeyForm({ ...keyForm, algorithm: e.target.value })}>{ALGORITHMS.map(([n, name]) => <option key={n} value={n}>{n}, {name}</option>)}</select>
                </label>
                <label>Public key
                  <textarea className="text-input area" rows={3} required value={keyForm.publicKey} onChange={(e) => setKeyForm({ ...keyForm, publicKey: e.target.value })} spellCheck={false} autoComplete="off" />
                </label>
                <p className="fineprint">The long text your DNS provider shows as the DNSKEY public key. A whole record line such as <code>257 3 13 AwEAA…</code> works too.</p>
                <div className="row-actions"><button type="submit" className="btn secondary" disabled={!!req}>Add DNSSEC key</button></div>
              </form>
            )}
            {canAddKey && keyInput === "ds" && (
              <form className="form-grid" aria-labelledby="dsadd-h" onSubmit={submitDs}>
                <h4 id="dsadd-h">Add a DNSSEC record</h4>
                <label>Key tag<input className="text-input" inputMode="numeric" required value={dsForm.keyTag} onChange={(e) => setDsForm({ ...dsForm, keyTag: e.target.value })} autoComplete="off" /></label>
                <label>Algorithm
                  <select className="text-input" value={dsForm.algorithm} onChange={(e) => setDsForm({ ...dsForm, algorithm: e.target.value })}>{ALGORITHMS.map(([n, name]) => <option key={n} value={n}>{n}, {name}</option>)}</select>
                </label>
                <label>Digest type
                  <select className="text-input" value={dsForm.digestType} onChange={(e) => setDsForm({ ...dsForm, digestType: e.target.value })}>{DIGEST_TYPES.map(([n, name, len]) => <option key={n} value={n}>{n}, {name} ({len} characters)</option>)}</select>
                </label>
                <label>Digest, in hex<input className="text-input" required value={dsForm.digest} onChange={(e) => setDsForm({ ...dsForm, digest: e.target.value })} autoComplete="off" spellCheck={false} /></label>
                <p className="fineprint">Your DNS provider shows these four values as the DS record for the zone.</p>
                <div className="row-actions"><button type="submit" className="btn secondary" disabled={!!req}>Add DNSSEC record</button></div>
              </form>
            )}
          </>
        )}
        {req?.type === "domain.nameservers.change" && (req.input as { kind?: string })?.kind !== "nameservers" && <StepUp key="ds" req={req} onDone={() => { setReq(null); void load(); }} />}
      </div>

      <ContactSection f={f} sec={sec} reloadAll={reloadAll} />
    </div>
  );
}

function ContactSection({ f, sec, reloadAll }: { f: string; sec: Security | null; reloadAll: () => void }) {
  const [ver, setVer] = useState<VerificationState | null>(null);
  const [code, setCode] = useState("");
  const [form, setForm] = useState<ContactFields>({ name: "", email: "", phone: "", street: "", city: "", region: "", postalCode: "", country: "US" });
  const [warn, setWarn] = useState<string[]>([]);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const loadVer = useCallback(() => { void getVerification(f).then(setVer).catch(() => setVer(null)); }, [f]);
  useEffect(() => { loadVer(); }, [loadVer]);
  useEffect(() => { if (open) void getContactStart(f).then((c) => { if (c.current) setForm((x) => ({ ...x, name: c.current!.name, email: c.current!.email, country: c.current!.country })); }).catch(() => undefined); }, [open, f]);
  const run = async (fn: () => Promise<string | void>) => { setBusy(true); setMsg(null); try { const m = await fn(); if (m) setMsg(m); } catch (e) { if (await sessionEnded(e)) return; setMsg(explainDomain(e)); } finally { setBusy(false); } };
  const set = (k: keyof ContactFields) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });
  const v = ver?.verification ?? null;
  const pending = v && v.state !== "verified";
  const held = v?.state === "suspended" || ver?.provider?.suspended === true;
  // The registrar runs the check itself where `source` is provider: only the link in its own email counts, so that is what is offered.
  const byRegistrar = ver?.source === "provider";
  const days = v?.days_left ?? 0;

  return (
    <div className="section" role="group" aria-labelledby="ct-h">
      <h3 id="ct-h">Contact and registrant</h3>
      {pending && (
        <div className="banner" role="status">
          <p>
            {held ? "This name is on hold because the registrant email was not verified in time." : `Verify the registrant email within ${days} ${days === 1 ? "day" : "days"}, or the name is put on hold.`}{" "}
            {byRegistrar
              ? "Our registrar emailed that address a verification link when the name was registered: open that email and use the link. If it is not in the inbox within a minute, look in Junk, or send it again below. Once the link is used, this notice goes away the next time you open this page."
              : "We send an eight-digit code to that address. If it is not in your inbox within a minute, look in Junk: our mail is new to most providers."}
          </p>
          {byRegistrar ? (
            <div className="row-actions"><button type="button" className="btn secondary" disabled={busy} onClick={() => void run(async () => { const r = await sendVerification(f); return r.sent ? "The registrar is sending its email again." : "The email could not be sent again just now. Try again in a little while."; })}>Send the email again</button></div>
          ) : (
            <>
              <div className="row-actions"><button type="button" className="btn secondary" disabled={busy} onClick={() => void run(async () => { await sendVerification(f); return "If the address can be reached, a code is on its way."; })}>Email me a code</button></div>
              <form onSubmit={(e) => { e.preventDefault(); void run(async () => { await verifyRegistrant(f, code.trim()); setCode(""); loadVer(); reloadAll(); return "The registrant email is verified."; }); }}>
                <label htmlFor="rv-code">Eight-digit code</label>
                <input id="rv-code" className="text-input" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
                <div className="row-actions"><button type="submit" className="btn secondary" disabled={busy}>Verify</button></div>
              </form>
            </>
          )}
        </div>
      )}
      {sec?.contact_change && <p className="notice" role="status">A contact change is waiting for approval by email{sec.contact_change.approval_deadline_at ? ` until ${new Date(sec.contact_change.approval_deadline_at).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}` : ""}.</p>}
      {msg && <p role="status" className="notice">{msg}</p>}
      {!open ? <div className="row-actions"><button type="button" className="btn secondary" onClick={() => setOpen(true)}>Change contact details</button></div> : (
        <form className="form-grid" aria-label="New contact details" onSubmit={(e) => { e.preventDefault(); void run(async () => {
          // The phone is read on the page first (any usual way of writing it), so a shape is never the reason a change is refused.
          const phone = normalizePhone(form.phone, form.country);
          if (!phone) return PHONE_PROBLEM;
          const dr = await draftContact(f, { ...form, phone, country: form.country.trim().toUpperCase() });
          setWarn(dr.warnings.map((w) => w.message));
          setReq({ type: "domain.contact.change", target: dr.id, run: async (id) => { const r = await submitContact(f, id); setOpen(false); setWarn([]); setMsg(r.status === "applied" ? "Contact details updated." : "Sent. Both the current and the new registrant must approve it by email."); loadVer(); reloadAll(); } });
        }); }}>
          <label>Full name<input className="text-input" required value={form.name} onChange={set("name")} autoComplete="off" /></label>
          <label>Email<input className="text-input" type="email" required value={form.email} onChange={set("email")} autoComplete="off" /></label>
          <label>Phone<input className="text-input" type="tel" inputMode="tel" required value={form.phone} onChange={set("phone")} autoComplete="off" aria-describedby="dc-phone-hint" /></label>
          <p id="dc-phone-hint" className="fineprint">{PHONE_HINT}</p>
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
