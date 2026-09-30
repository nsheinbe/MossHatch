import { useEffect, useState } from "react";
import {
  authorisationDoc, autoRenewOff, day, explainDomain, money, renewNow, setAutoRenewOn, stopTransfer,
  type DomainDetail, type Security, type TransferState,
} from "../lib/domains";
import { StepUp, type StepUpRequest } from "./StepUp";
import { TransferCode } from "./TransferCode";

const years = (n: number | null) => (n === 1 ? "1 year" : `${n ?? 1} years`);

export function DomainOverview({ d, sec, xfer, reload }: { d: DomainDetail; sec: Security | null; xfer: TransferState | null; reload: () => void }) {
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [agree, setAgree] = useState(false);
  const [doc, setDoc] = useState<{ version: string; url: string } | null | undefined>(undefined);
  const on = d.auto_renew;
  useEffect(() => { if (!on) void authorisationDoc().then(setDoc).catch(() => setDoc(null)); }, [on]);

  const attention = sec?.attention?.message ?? (d.state === "attention" ? d.state_text : null);
  const price = d.renewal.price_minor ? money(d.renewal.price_minor) : null;
  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true); setMsg(null);
    try { const m = await fn(); if (m) setMsg(m); reload(); } catch (e) { setMsg(explainDomain(e)); } finally { setBusy(false); }
  };

  return (
    <div>
      {attention && (
        <div className="banner" role="alert">
          <h3>Needs you</h3>
          <p>{attention}</p>
          {xfer?.stop_available && (
            <div className="row-actions">
              <button type="button" className="btn primary" disabled={busy} onClick={() => void act(async () => { await stopTransfer(d.fqdn); return "Stopped. The name is locked again and its code was replaced. Our team has been told."; })}>Stop this transfer</button>
            </div>
          )}
          {xfer?.note && <p className="notice">{xfer.note}</p>}
        </div>
      )}
      {sec?.account_frozen && <p className="notice" role="status">Your account is frozen. Nothing will be unlocked or changed, and renewals continue.</p>}
      {msg && <p role="status" className="notice">{msg}</p>}

      <dl className="rows facts">
        <div><dt>Status</dt><dd>{d.state_text}{d.confirmed ? "" : " (not confirmed just now)"}</dd></div>
        <div><dt>Expires</dt><dd>{d.expires_at ? day(d.expires_at) : "Not known yet"}{d.days_to_expiry !== null && d.days_to_expiry >= 0 ? `, in ${d.days_to_expiry} ${d.days_to_expiry === 1 ? "day" : "days"}` : ""}</dd></div>
        <div><dt>Renewal price</dt><dd>{price ? `${price} for ${years(d.renewal.years)}` : "Not known yet"}{d.renewal.charge_at && on ? `, charged ${day(d.renewal.charge_at)}` : ""}</dd></div>
        <div><dt>Transfer lock</dt><dd>{d.locked ? "On" : "Off"}</dd></div>
        <div><dt>Transfer</dt><dd>{xfer ? ({ none: "None in progress", requested: "In progress, and you asked for it", unrequested: "In progress, and you did not ask for it", stopped_pending: "Stopped, waiting for our team" }[xfer.state]) : "Not known just now"}</dd></div>
        {sec?.registrant_verification && sec.registrant_verification.state !== "verified" && <div><dt>Registrant email</dt><dd>Not verified yet. See the DNS tab.</dd></div>}
      </dl>

      <div className="section" role="group" aria-labelledby="ren-h">
        <h3 id="ren-h">Renewal</h3>
        {on ? (
          <>
            <p>Auto-renew is <strong>on</strong>.{d.mandate ? ` We charge your saved card ${d.mandate.charge_days_before_expiry} days before it expires, up to ${money(d.mandate.price_ceiling_minor)} for ${years(d.mandate.term_years)}.` : ""}</p>
            <div className="row-actions">
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void act(async () => { await autoRenewOff(d.id); return "Auto-renew is off."; })}>Turn off auto-renew</button>
            </div>
          </>
        ) : (
          <>
            <p>Auto-renew is <strong>off</strong>. The name will expire unless you renew it.</p>
            <div className="consent" role="group" aria-labelledby="consent-h">
              <h4 id="consent-h">Auto-renew authorisation</h4>
              <p>If you turn this on, ten days before this name expires we charge your saved card the renewal price{price ? `, up to ${price} for ${years(d.renewal.years)}` : ""}. We email you first. You can turn it off any time with one click, and nothing is charged after that.</p>
              <p>{doc ? <a href={doc.url} target="_blank" rel="noopener">Read the full authorisation (opens in a new tab)</a> : doc === null ? "The authorisation text is not published yet." : ""}</p>
              <label className="check"><input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} /> I agree to this authorisation. It is separate from the terms of service.</label>
              <div className="row-actions">
                <button type="button" className="btn primary" disabled={busy || !agree || !doc || !!req}
                  onClick={() => { setMsg(null); setReq({ type: "mandate.sign", target: d.id, run: async (id) => { await setAutoRenewOn(d.id, doc!.version, id); setAgree(false); setMsg("Auto-renew is on."); reload(); } }); }}>
                  Turn on auto-renew
                </button>
              </div>
            </div>
          </>
        )}
        {req && <StepUp key={req.type} req={req} onDone={() => setReq(null)} />}
        <div className="row-actions">
          <button type="button" className="btn secondary" disabled={busy} onClick={() => void act(async () => {
            const r = await renewNow(d.id);
            return r.status === "renewed" ? "Renewed." : r.status === "refunded" ? "The renewal could not be finished, so it was refunded." : "Renewing now. This can take a minute.";
          })}>Renew now</button>
        </div>
      </div>

      <TransferCode fqdn={d.fqdn} locked={d.locked} onChanged={reload} />
    </div>
  );
}
