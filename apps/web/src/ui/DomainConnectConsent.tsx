import { useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { ApiError } from "../lib/api";
import {
  confirmDomainConnect, consentPath, explainConnect, planLines, previewDomainConnect, type DomainConnectPreview,
} from "../lib/connect";
import { StepUp, type StepUpRequest } from "./StepUp";

/**
 * Domain Connect sync consent (DC-08). The apply URL redirects here with the signed query intact.
 * Confirm is a same-origin JSON fetch; the page follows the `redirect` the server returns.
 * A sensitive diff is stored first, then the existing connect.apply passkey, then confirm again.
 */
export default function DomainConnectConsent({ onClose }: { onClose: () => void }) {
  const { apiReady, account, set } = useUi();
  const route = consentPath(location.pathname);
  const providerId = route?.providerId ?? "";
  const serviceId = route?.serviceId ?? "";
  const query = location.search.replace(/^\?/, "");
  const [preview, setPreview] = useState<DomainConnectPreview | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const followOrExplain = (e: unknown): string => {
    if (e instanceof ApiError && typeof e.body?.redirect === "string") { location.assign(e.body.redirect); return "Sending you back."; }
    if (e instanceof ApiError && e.status === 401) { set({ accountOpen: true }); return "Sign in to the account that owns this domain."; }
    return explainConnect(e);
  };
  useEffect(() => { head.current?.focus(); }, []);
  useEffect(() => { const h = (e: KeyboardEvent) => { if (e.key === "Escape" && !req) onClose(); }; window.addEventListener("keydown", h); return () => window.removeEventListener("keydown", h); }, [onClose, req]);
  useEffect(() => {
    if (!providerId || !serviceId || !query || apiReady !== true) return;
    let live = true;
    previewDomainConnect({ query, provider_id: providerId, service_id: serviceId }).then((r) => {
      if (!live) return;
      if (r.redirect) { location.assign(r.redirect); return; }
      setPreview(r);
    }).catch((e) => { if (live) setMsg(followOrExplain(e)); });
    return () => { live = false; };
  }, [apiReady, query, providerId, serviceId]); // eslint-disable-line react-hooks/exhaustive-deps -- followOrExplain closes over set, which is stable
  const go = async (decision: "confirm" | "cancel", actionId?: string) => {
    if (!providerId || !serviceId) return;
    setBusy(true); setMsg(null);
    try {
      const r = await confirmDomainConnect({ query, provider_id: providerId, service_id: serviceId, decision }, actionId);
      if (r.redirect) location.assign(r.redirect);
    } catch (e) {
      if (decision === "confirm" && e instanceof ApiError && e.code === "approval_required" && typeof e.body?.plan_id === "string") {
        const planId = e.body.plan_id;
        setReq({
          type: "connect.apply", target: planId,
          run: async (id) => {
            const r = await confirmDomainConnect({ query, provider_id: providerId, service_id: serviceId, decision: "confirm" }, id);
            if (r.redirect) location.assign(r.redirect);
          },
          explain: followOrExplain,
        });
        return;
      }
      setMsg(followOrExplain(e));
    } finally { setBusy(false); }
  };

  const plan = preview?.plan ?? null;
  const lines = plan ? planLines(plan) : null;
  const sensitive = (plan?.sensitive.length ?? 0) > 0;
  return (
    <main>
      <div className="panel ledger consent" role="region" aria-labelledby="dc-consent-h">
        <div className="head"><h2 id="dc-consent-h" ref={head} tabIndex={-1}>Apply DNS records</h2></div>
        <div className="body">
          {apiReady === false && <p className="notice">Accounts are not connected in this preview.</p>}
          {apiReady && !account && (
            <>
              <p className="notice">Sign in to the account that owns this domain before applying anything.</p>
              <div className="row-actions"><button type="button" className="btn primary" onClick={() => set({ accountOpen: true })}>Sign in</button></div>
            </>
          )}
          {!route && <p className="notice">This page opens from a service that asked to change DNS.</p>}
          {route && <p>{preview?.provider_name ?? route.providerId} wants to change DNS for {preview?.fqdn ?? "this domain"}. Nothing is written until you confirm. You see every record first.</p>}
          {msg && <p role="alert" className="notice">{msg}</p>}
          {lines && (
            <div className="plan-box">
              {lines.add.length > 0 && <><h3>Records to add</h3><ul className="plain">{lines.add.map((line) => <li key={`a-${line}`}><code>{line}</code></li>)}</ul></>}
              {lines.remove.length > 0 && <><h3>Records to remove</h3><ul className="plain">{lines.remove.map((line) => <li key={`r-${line}`}><code>{line}</code></li>)}</ul></>}
              {lines.add.length + lines.remove.length === 0 && <p>Nothing to change: these records are already in place.</p>}
              {plan?.warnings.map((w) => <p key={w.message} className="fineprint">{w.message}</p>)}
              {sensitive && <p className="notice">This changes a sensitive record, so it needs your passkey.</p>}
            </div>
          )}
          {req && <StepUp req={req} onDone={() => setReq(null)} />}
          {route && query && (
            <div className="row-actions">
              <button type="button" className="btn primary" disabled={busy || !account || !!req} onClick={() => void go("confirm")}>{busy ? "Applying." : "Confirm"}</button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void go("cancel")}>Cancel</button>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
