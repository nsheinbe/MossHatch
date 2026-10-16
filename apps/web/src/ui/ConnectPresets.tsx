import { useEffect, useState } from "react";
import {
  ALIAS_DELEGATE, APPLIED_NOTE, CHANGED_NOTE, approveConnectPlan, applyConnectPlan, blockedCopy, createConnectPlan, explainConnect,
  getCapabilities, getConnectPlan, listConnectPresets, planLines, presetsRequestsOn, presetsSectionOn, readPlanError, verifyNote,
  type ConnectCapabilities, type PresetInfo, type StoredPlan,
} from "../lib/connect";
import type { DomainDetail } from "../lib/domains";
import { ApiError } from "../lib/api";
import { useUi } from "../store";
import { StepUp, type StepUpRequest } from "./StepUp";

/**
 * DNS presets on the existing Connect tab (DC-06). Absent unless `connect.ui` is on, and it does not
 * request a preset or a plan until presets are on too. The recipes above this section are unchanged.
 */
export function ConnectPresets({ d }: { d: DomainDetail }) {
  const set = useUi((s) => s.set);
  const [caps, setCaps] = useState<ConnectCapabilities | null>(null);
  const [presets, setPresets] = useState<PresetInfo[]>([]);
  const [id, setId] = useState("");
  const [input, setInput] = useState<Record<string, string>>({});
  const [planned, setPlanned] = useState<StoredPlan | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [applied, setApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [verifyState, setVerifyState] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setCaps(null); setPresets([]); setPlanned(null); setApplied(false); setNote(null);
    getCapabilities().then(async (c) => {
      if (!live) return;
      setCaps(c);
      if (!presetsRequestsOn(c)) return;
      const list = await listConnectPresets();
      if (live) { setPresets(list.presets); setId(list.presets[0]?.id ?? ""); }
    }).catch(() => { if (live) setCaps(null); });
    return () => { live = false; };
  }, [d.fqdn]);
  useEffect(() => {
    if (!applied || !caps?.verify || !planned) return;
    let live = true;
    const id = planned.plan_id;
    const load = () => { getConnectPlan(d.fqdn, id).then((r) => { if (live) setVerifyState(r.verify_state); }).catch(() => undefined); };
    load();
    const t = window.setInterval(load, 30_000);
    return () => { live = false; window.clearInterval(t); };
  }, [applied, caps?.verify, d.fqdn, planned]);

  if (!presetsSectionOn(caps) || !caps) return null;
  const preset = presets.find((p) => p.id === id) ?? null;
  const showChanged = (e: unknown): boolean => {
    if (!(e instanceof ApiError)) return false;
    const fault = readPlanError(e);
    if (fault?.kind !== "changed" || !planned) return false;
    setPlanned({ ...planned, plan: fault.plan, plan_hash: fault.plan_hash });
    setApplied(false);
    setNote(CHANGED_NOTE);
    return true;
  };
  const preview = async () => {
    if (!preset || !caps.apply) return;
    setBusy(true); setNote(null); setApplied(false); setReq(null); setPlanned(null);
    try {
      setPlanned(await createConnectPlan(d.fqdn, { source: "preset", source_id: preset.id, source_version: preset.version, input }));
    } catch (e) {
      if (e instanceof ApiError) {
        const fault = readPlanError(e);
        if (fault?.kind === "blocked") { setNote(blockedCopy(fault.code, fault.message, caps.delegate)); return; }
      }
      setNote(explainConnect(e));
    } finally { setBusy(false); }
  };
  const apply = async (stored: StoredPlan) => {
    await applyConnectPlan(d.fqdn, stored.plan_id, stored.plan_hash);
    setApplied(true);
    setNote(APPLIED_NOTE);
  };
  const confirm = async () => {
    if (!planned) return;
    setBusy(true); setNote(null); setApplied(false);
    try { await apply(planned); }
    catch (e) { if (!showChanged(e)) setNote(explainConnect(e)); }
    finally { setBusy(false); }
  };
  const sensitive = planned !== null && planned.plan.sensitive.length > 0;
  const lines = planned ? planLines(planned.plan) : null;
  return (
    <section className="recipe-card" aria-labelledby="connect-presets-h">
      <h4 id="connect-presets-h">DNS presets</h4>
      <p>These records are written here, on the nameservers this name already uses. You see every add and every remove before anything is written.</p>
      {!caps.presets && <p>Presets are turned off.</p>}
      {caps.presets && !caps.apply && <p>Connect plans are turned off.</p>}
      {preset && (
        <form className="form-grid" onSubmit={(e) => { e.preventDefault(); void preview(); }} aria-label={preset.title}>
          <label>Preset
            <select className="text-input" value={id} onChange={(e) => { setId(e.target.value); setInput({}); setPlanned(null); setApplied(false); setNote(null); }}>
              {presets.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
            </select>
          </label>
          {preset.fields.map((f) => (
            <label key={f.name}>{f.label}
              <input className="text-input" required={f.required} placeholder={f.placeholder} autoComplete="off" spellCheck={false} value={input[f.name] ?? ""} onChange={(e) => setInput({ ...input, [f.name]: e.target.value })} />
            </label>
          ))}
          <p className="fineprint"><a href={preset.doc} target="_blank" rel="noreferrer noopener">How {preset.title} documents this</a></p>
          <div className="row-actions"><button type="submit" className="btn primary" disabled={busy || !caps.apply}>{busy ? "Preparing." : "Preview the records"}</button></div>
        </form>
      )}
      {planned && lines && (
        <div className="plan-box">
          {planned.plan.source === "ai" && <p>These records were inferred. Check each one before you apply them.</p>}
          {lines.add.length > 0 && <><h5>Records to add</h5><ul className="plain">{lines.add.map((line) => <li key={`a-${line}`}><code>{line}</code></li>)}</ul></>}
          {lines.remove.length > 0 && <><h5>Records to remove</h5><ul className="plain">{lines.remove.map((line) => <li key={`r-${line}`}><code>{line}</code></li>)}</ul></>}
          {lines.add.length + lines.remove.length === 0 && <p>Nothing to change: these records are already in place.</p>}
          {planned.plan.warnings.map((w) => <p key={w.message} className="fineprint">{w.message}</p>)}
          {sensitive && <p className="notice">This changes a sensitive record, so it needs your passkey.</p>}
          <div className="row-actions">
            {sensitive
              ? <button type="button" className="btn primary" disabled={busy || !!req} onClick={() => {
                const stored = planned;
                setReq({
                  type: "connect.apply", target: stored.plan_id,
                  run: async (actionId) => { await approveConnectPlan(stored.plan_id, actionId); await apply(stored); },
                  explain: (e) => showChanged(e) ? CHANGED_NOTE : explainConnect(e),
                });
              }}>Approve with passkey</button>
              : <button type="button" className="btn primary" disabled={busy} onClick={() => void confirm()}>{busy ? "Applying." : "Apply"}</button>}
            <button type="button" className="btn secondary" disabled={busy} onClick={() => { setPlanned(null); setReq(null); setApplied(false); }}>Cancel</button>
          </div>
          {req && <StepUp req={req} onDone={() => setReq(null)} />}
        </div>
      )}
      {note && <p role="status" className="notice">{note}</p>}
      {note === ALIAS_DELEGATE && <p className="fineprint">The nameserver form is on the DNS tab.</p>}
      {applied && caps.verify && <p role="status">{verifyNote(verifyState)}</p>}
      {applied && <div className="row-actions"><button type="button" className="btn secondary" onClick={() => set({ domainTab: "dns" })}>Open the DNS tab</button></div>}
    </section>
  );
}
