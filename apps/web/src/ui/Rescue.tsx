import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { money } from "../lib/domains";
import { getContact, getDocuments, type LegalDoc } from "../lib/orders";
import {
  cancelTransfer, confirmTransfer, day, explainTransfer, getTransferView, headline, isDone, isOver, startTransfer, steps, transferYears, type TransferView,
} from "../lib/transfers";
import { ContactForm } from "./ContactForm";
import { keepHandoff } from "../lib/handoff";

/**
 * Rescue: bring a name here from another registrar. Steps: the code from the current registrar (a password field with autocomplete
 * off, read once from the field and cleared, never in state, the store, storage or the URL) and the terms; the server's pre-check
 * answers with a plain reason and, for the 60-day rules, the day they lift; then the code emailed to the registrant; then payment on
 * Stripe; then the status, which says the name moved only when the server says `completed`.
 */
export default function Rescue() {
  const { rescue, account, set } = useUi();
  const head = useRef<HTMLHeadingElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const key = useRef<string>(crypto.randomUUID());
  const [docs, setDocs] = useState<LegalDoc[]>([]);
  const [hasContact, setHasContact] = useState<boolean | null>(null);
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [view, setView] = useState<TransferView | null>(null);
  const [confirmCode, setConfirmCode] = useState("");
  const fqdn = rescue?.fqdn ?? "";
  const transferId = rescue?.transferId ?? null;

  useEffect(() => { head.current?.focus(); }, [fqdn]);
  useEffect(() => {
    if (!rescue) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") set({ rescue: null }); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [rescue, set]);
  useEffect(() => {
    if (!account || transferId) return;
    void getDocuments(fqdn.split(".").pop()).then(setDocs).catch(() => setDocs([]));
    void getContact().then((c) => setHasContact(c.present)).catch(() => setHasContact(false));
  }, [account, transferId, fqdn]);

  // Follow a started transfer. While it is live the server is asked again every few seconds; nothing is guessed in between.
  const refresh = useCallback(async () => {
    if (!transferId) return;
    try { setView(await getTransferView(transferId)); setErr(null); } catch (e) { setErr(explainTransfer(e)); }
  }, [transferId]);
  useEffect(() => { setView(null); void refresh(); }, [refresh]);
  const live = !!view && !isOver(view) && view.state !== "awaiting_confirmation";
  useEffect(() => {
    if (!live) return;
    const t = window.setInterval(() => { if (!document.hidden) void refresh(); }, 4000);
    return () => window.clearInterval(t);
  }, [live, refresh]);

  if (!rescue) return null;
  const close = () => set({ rescue: null });
  const doc = (k: string) => docs.find((x) => x.kind === k);
  const docsReady = !!doc("terms") && !!doc("registration_agreement");

  const start = async (e: React.FormEvent) => {
    e.preventDefault();
    const field = codeRef.current;
    const code = field?.value.trim() ?? "";
    // The code leaves the field before anything else happens, whatever the answer.
    if (field) field.value = "";
    if (!code) { setErr("Enter the transfer code from your current registrar."); return; }
    setBusy(true); setErr(null);
    try {
      const out = await startTransfer(fqdn, transferYears(fqdn), code, { terms: doc("terms")!.version, registration_agreement: doc("registration_agreement")!.version }, key.current);
      set({ rescue: { fqdn, transferId: out.transfer_id, orderId: out.order_id } });
    } catch (x) { setErr(explainTransfer(x)); key.current = crypto.randomUUID(); }
    finally { if (codeRef.current) codeRef.current.value = ""; setBusy(false); }
  };
  const confirm = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!view) return;
    setBusy(true); setErr(null);
    try {
      const out = await confirmTransfer(view.id, confirmCode.trim().toUpperCase());
      setConfirmCode("");
      setView(out);
      if (out.checkout_url) {
        keepHandoff(out.order_id, out.id);
        window.location.assign(out.checkout_url);
        return;
      }
    } catch (x) { setErr(explainTransfer(x)); void refresh(); }
    setBusy(false);
  };
  const cancel = async () => {
    if (!view) return;
    setBusy(true); setErr(null);
    try { setView(await cancelTransfer(view.id)); } catch (x) { setErr(explainTransfer(x)); void refresh(); }
    finally { setBusy(false); }
  };

  return (
    <aside className="panel side wide" role="region" aria-label={`Transfer ${fqdn} here`}>
      <div className="head"><h2 ref={head} tabIndex={-1}>Bring {fqdn} here</h2></div>
      <div className="body">
        {!account && (
          <>
            <p>Sign in to move a name you own at another registrar to Mosshatch.</p>
            <div className="row-actions"><button type="button" className="btn primary" onClick={() => set({ accountOpen: true })}>Sign in to transfer</button></div>
          </>
        )}

        {account && !transferId && !rescue.orderId && (
          <>
            <p>A transfer moves the name from its current registrar to us and adds {transferYears(fqdn) === 1 ? "one year" : "two years"} to it. The time already paid is kept.</p>
            <p className="notice">A transfer can take several days and sometimes about two weeks. It stays Traveling until the registry confirms.</p>
            {hasContact === false && <ContactForm email={account.user.email} onSaved={() => setHasContact(true)} />}
            {hasContact && (
              <form className="form-grid" aria-label="Start the transfer" onSubmit={(e) => void start(e)} autoComplete="off">
                <label htmlFor="rescue-code">Transfer code from your current registrar</label>
                <input
                  id="rescue-code" ref={codeRef} className="text-input mono" type="password" autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false}
                  maxLength={64} aria-describedby="rescue-code-help" data-1p-ignore="" data-lpignore="true"
                />
                <p id="rescue-code-help" className="notice">Also called an auth code or EPP code. We send it to our registrar once and never show it again. The field is cleared when you press the button.</p>
                <p className="check">
                  <input id="rescue-accept" type="checkbox" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
                  <label htmlFor="rescue-accept">I accept the <a href={doc("terms")?.url ?? "/legal/terms.html"} target="_blank" rel="noreferrer">terms of service</a> and the <a href={doc("registration_agreement")?.url ?? "/legal/registration-agreement.html"} target="_blank" rel="noreferrer">registration agreement</a>.</label>
                </p>
                {err && <p role="alert" className="warn">{err}</p>}
                <div className="row-actions">
                  <button type="submit" className="btn primary" disabled={busy || !accepted || !docsReady}>{busy ? "Checking" : "Check and start the transfer"}</button>
                </div>
                <p className="notice">We check that the name can move before anything is charged. Nothing is charged until you pay on Stripe.</p>
              </form>
            )}
          </>
        )}

        {account && !transferId && rescue.orderId && (
          <p role="status">Your payment is in. The transfer of {fqdn} is under way, and we email you at each step.</p>
        )}

        {account && transferId && !view && !err && <p role="status">Checking the transfer.</p>}
        {account && transferId && err && <p role="alert" className="warn">{err}</p>}

        {account && view && view.state === "awaiting_confirmation" && (
          <form className="form-grid" aria-label="Confirm the transfer" onSubmit={(e) => void confirm(e)}>
            <p>We emailed a code to the registrant email of {view.fqdn}. Enter it to confirm the transfer. It works for 30 minutes.</p>
            {view.payment.total_minor && <p>You pay {money(view.payment.total_minor)} for {view.years === 1 ? "one added year" : `${view.years} added years`}, on Stripe next. We hold it on your card and take it when the transfer completes.</p>}
            <label htmlFor="rescue-confirm">Eight-character code from the email</label>
            <input id="rescue-confirm" className="text-input mono" value={confirmCode} maxLength={8} autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} onChange={(e) => setConfirmCode(e.target.value)} />
            <div className="row-actions">
              <button type="submit" className="btn primary" disabled={busy || confirmCode.trim().length !== 8}>Confirm and pay on Stripe</button>
              <button type="button" className="btn secondary" disabled={busy} onClick={() => void cancel()}>Cancel the transfer</button>
            </div>
          </form>
        )}

        {account && view && view.state !== "awaiting_confirmation" && <TransferStatus v={view} busy={busy} onPay={() => void confirm()} onCancel={() => void cancel()} />}

        <div className="row-actions"><button type="button" className="btn secondary" onClick={close}>Close</button></div>
      </div>
    </aside>
  );
}

/** The status of one transfer. "Moved" appears only when the server reports `completed`; until then it is Traveling. */
export function TransferStatus({ v, busy, onPay, onCancel }: { v: TransferView; busy: boolean; onPay: () => void; onCancel: () => void }) {
  const set = useUi((s) => s.set);
  const done = isDone(v);
  return (
    <div className="transfer-status" role="group" aria-labelledby="xfer-status-h">
      <h3 id="xfer-status-h">Transfer status</h3>
      <p role="status"><strong>{headline(v)}</strong></p>
      <p>{done ? v.message : v.failure?.message ?? v.message}</p>
      <ol className="xfer-steps">
        {steps(v).map((s) => <li key={s.label} data-status={s.status}><span className="sr-only">{s.status === "done" ? "Done: " : s.status === "now" ? "Now: " : s.status === "stopped" ? "Stopped: " : "Later: "}</span>{s.label}</li>)}
      </ol>
      {v.owner_deadline_at && <p className="notice">The owner has until {day(v.owner_deadline_at)} to approve.</p>}
      {v.registry_deadline_at && <p className="notice">If the current registrar stays silent, the registry moves the name on {day(v.registry_deadline_at)}.</p>}
      {!isOver(v) && <p className="notice">{v.timing}</p>}
      {v.payment.note && <p className="notice">{v.payment.note}</p>}
      {v.payment.refunded && <p className="notice">The payment was refunded.</p>}
      {done && v.payment.charged_minor && <p className="notice">Charged {money(v.payment.charged_minor)}.</p>}
      <div className="row-actions">
        {v.state === "awaiting_payment" && <button type="button" className="btn primary" disabled={busy} onClick={onPay}>Pay on Stripe</button>}
        {v.can_cancel && <button type="button" className="btn secondary" disabled={busy} onClick={onCancel}>Cancel the transfer</button>}
        {done && v.domain_id && <button type="button" className="btn primary" onClick={() => set({ rescue: null, view: "grove", domainPanel: { id: v.domain_id!, fqdn: v.fqdn } })}>Open {v.fqdn}</button>}
      </div>
    </div>
  );
}
