import { useCallback, useEffect, useRef, useState } from "react";
import { api, ApiError } from "../lib/api";
import { explainDomain, gated, type StepUpType } from "../lib/domains";
import { StepUp, type StepUpRequest } from "./StepUp";

/**
 * "Download my data" and "Close my account" (PLAN 4.3b, docs/design/account-closure-export-erasure.md). Lazy chunk, opened from Your
 * account. Both requests need the passkey. Nothing fetched here is persisted: the export arrives as bytes in memory and goes straight
 * to a file the browser saves.
 */

interface ExportRow { id: string; state: "requested" | "building" | "ready" | "expired" | "failed" | "cancelled"; requested_at: string; ready_at: string | null; expires_at: string | null; size_bytes: number | null }
interface ClosureView { cooling_off_days: number; domains: { id: string; fqdn: string; transfer_out_in_progress: boolean }[]; blockers: string[] }

const when = (s: string | null) => (s ? new Date(s).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "");
const size = (n: number | null) => (n === null ? "" : n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10_240 ? 1 : 0)} KB`);

function explainData(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "export_in_progress": return "A copy is already being made. We email you when it is ready.";
      case "rate_limited": return "You can ask for three copies in 30 days. Download the one you have, or try again later.";
      case "export_unavailable": return "That copy has expired. Make a new one.";
      case "link_invalid": return "That download link expired. Try again.";
      case "recovery_hold": return "Account recovery put a hold on this for now. Try again when the hold ends.";
      case "closure_blocked": return "An order or a transfer is still in progress. Close your account when it has finished.";
      case "domains_remain": return "Names are still in your account. Transfer them out first, or tick the box to delete them.";
      case "action_stale": return "Something changed while you were signing. Look again, then try once more.";
      case "account_not_active": return "Your account is not open, so this cannot be done.";
    }
  }
  return explainDomain(e);
}

/** Two calls: a one-time ticket for this session, then the file itself. The bytes become a file the browser saves; nothing is kept. */
async function saveExport(id: string): Promise<void> {
  const t = await api<{ token: string }>("POST", `/api/v1/account/exports/${encodeURIComponent(id)}/link`, {});
  const f = await api<{ filename: string; content_type: string; data: string }>("POST", `/api/v1/account/exports/${encodeURIComponent(id)}/download`, { token: t.token });
  const bytes = Uint8Array.from(atob(f.data), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: f.content_type }));
  const a = document.createElement("a");
  a.href = url; a.download = f.filename; a.hidden = true;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export default function AccountData({ mode, userId, onDone, onClosed }: { mode: "export" | "close"; userId: string; onDone: () => void; onClosed: (message: string) => void }) {
  const [exports, setExports] = useState<ExportRow[] | null>(null);
  const [view, setView] = useState<ClosureView | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [deleteNames, setDeleteNames] = useState(false);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const head = useRef<HTMLHeadingElement>(null);

  const load = useCallback(async () => {
    try {
      if (mode === "export") setExports((await api<{ exports: ExportRow[] }>("GET", "/api/v1/account/exports")).exports);
      else setView(await api<ClosureView>("GET", "/api/v1/account/closure"));
    } catch (e) { setMsg(explainData(e)); }
  }, [mode]);
  useEffect(() => { setMsg(null); setReq(null); void load(); head.current?.focus(); }, [load]);

  const askExport = () => {
    setMsg(null);
    setReq({
      type: "account.export" as StepUpType, target: userId, explain: explainData,
      run: async (actionId) => { await api("POST", "/api/v1/account/export", {}, gated(actionId)); setMsg("We are making your copy. We email you when it is ready, and it downloads here for 7 days."); await load(); },
    });
  };
  const download = async (id: string) => {
    setBusy(true); setMsg(null);
    try { await saveExport(id); setMsg("Your copy is downloading."); await load(); }
    catch (e) { setMsg(explainData(e)); }
    finally { setBusy(false); }
  };
  const askClose = () => {
    setMsg(null);
    setReq({
      type: "account.close" as StepUpType, target: userId, input: view && view.domains.length ? { delete_domains: deleteNames } : {}, explain: explainData,
      run: async (actionId) => {
        const r = await api<{ closure: { cooling_off_until: string } }>("POST", "/api/v1/account/close", {}, gated(actionId));
        onClosed(`Your account is closing. To keep it, sign in with your passkey before ${when(r.closure.cooling_off_until)}.`);
      },
    });
  };

  const ready = (exports ?? []).filter((x) => x.state === "ready");
  const making = (exports ?? []).some((x) => x.state === "requested" || x.state === "building");
  const blocked = !!view && view.blockers.length > 0;
  const names = view?.domains ?? [];

  return (
    <section className="account-data" aria-labelledby="account-data-h">
      <h3 id="account-data-h" ref={head} tabIndex={-1}>{mode === "export" ? "Download my data" : "Close my account"}</h3>
      {mode === "export" && (
        <>
          <p>A copy of your account data as a ZIP file: one JSON file, and a spreadsheet file for each kind of record. Secret values are never in it.</p>
          {!exports && !msg && <p role="status">Loading.</p>}
          {ready.map((x) => (
            <div key={x.id} className="row-actions">
              <span>Ready {when(x.ready_at)}, {size(x.size_bytes)}. Downloads until {when(x.expires_at)}.</span>
              <button type="button" className="btn primary" disabled={busy} onClick={() => void download(x.id)}>Download</button>
            </div>
          ))}
          {making && <p className="notice">We are making your copy. We email you when it is ready.</p>}
          {exports && !making && !req && <div className="row-actions"><button type="button" className="btn secondary" onClick={askExport}>Make a new copy</button></div>}
        </>
      )}
      {mode === "close" && (
        <>
          <p>Closing signs you out everywhere, revokes your tokens and connected apps, turns off auto-renew and takes down your cards. For {view?.cooling_off_days ?? 14} days, signing in with your passkey cancels it. Then we erase your personal data. Receipts and payment records stay as the law requires.</p>
          <p className="notice">Download your data first if you want a copy: after you close, you cannot sign in to get it.</p>
          {!view && !msg && <p role="status">Loading.</p>}
          {blocked && <p className="notice">An order or a transfer is still in progress. Close your account when it has finished.</p>}
          {view && !blocked && names.length > 0 && (
            <>
              <p>These names are still in your account:</p>
              <ul>{names.map((d) => <li key={d.id}>{d.fqdn}{d.transfer_out_in_progress ? " (transfer out in progress)" : ""}</li>)}</ul>
              <p>To keep a name, transfer it out first: open it and choose Transfer out. If you close now, we ask the registry to delete the rest after {view.cooling_off_days} days, and deletion is final.</p>
              <label className="check"><input type="checkbox" checked={deleteNames} onChange={(e) => setDeleteNames(e.target.checked)} /> Delete my remaining names at the registry when my account closes.</label>
            </>
          )}
          {view && !blocked && !req && (
            <div className="row-actions">
              <button type="button" className="btn primary" disabled={names.length > 0 && !deleteNames} onClick={askClose}>Close with my passkey</button>
            </div>
          )}
        </>
      )}
      {req && <StepUp req={req} onDone={() => setReq(null)} />}
      {msg && <p role="status" className="notice">{msg}</p>}
      <div className="row-actions"><button type="button" className="btn secondary" onClick={onDone}>Back</button></div>
    </section>
  );
}
