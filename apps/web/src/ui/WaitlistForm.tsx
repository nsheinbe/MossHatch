import { useEffect, useRef, useState } from "react";
import { joinWaitlist, type WaitlistOpen } from "../lib/waitlist";
import { CONSENT_TEXT, QUESTION_TEXT } from "./waitlistText";

const ERRORS: Record<string, string> = {
  invalid_email: "That email address does not look right.",
  invalid_name: "The name should be letters, numbers and hyphens, with an optional extension such as .com.",
  consent_required: "Tick the box to agree to the emails. We cannot add you without it.",
  rate_limited: "Too many sign-ups from this network. Try again in an hour.",
  busy: "Lots of people are joining right now. Try again in a few minutes.",
  not_configured: "The waitlist is not taking sign-ups at the moment. Try again later.",
  delivery_unavailable: "We could not deliver your confirmation email. Try again later. Your place is confirmed only after you use the confirmation link.",
  network: "We could not reach Mosshatch. Check your connection and try again.",
};

/** The waitlist form, in a modal dialog (focus stays inside, Escape closes, focus returns to what opened it). A lazy chunk. */
export default function WaitlistForm({ name, email, source, onClose }: WaitlistOpen & { onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [f, setF] = useState({ email: email ?? "", name: name ?? "", answer: "", consent: false, website: "" });
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const d = ref.current;
    if (d && !d.open) d.showModal();
    return () => { opener?.focus?.(); };
  }, []);
  const close = () => { ref.current?.close(); };
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null); setBusy(true);
    try {
      await joinWaitlist({ email: f.email.trim(), name: f.name.trim() || undefined, answer: f.answer || undefined, consent: f.consent, website: f.website, source: source ?? "app" });
      setSent(true);
    } catch (x) { setErr(ERRORS[(x as Error).message] ?? "Something went wrong. Try again."); }
    finally { setBusy(false); }
  };
  return (
    <dialog ref={ref} className="panel waitlist" aria-labelledby="wl-h" onClose={onClose}>
      <div className="head"><h2 id="wl-h">{sent ? "Check your email" : "Join the waitlist"}</h2></div>
      <div className="body">
        {sent ? (
          <>
            <p role="status">Your request was received. If this address needs confirmation, look for a link that works for 7 days. Your place is confirmed only after you use the link. If you already joined, look for a short note instead.</p>
            <p>Check your inbox and spam folder. To limit unwanted email, repeated requests may not send another message. If no message arrives, try again later.</p>
            <p>Joining does not reserve or register a name. We let people in a few at a time and email an invite when it is your turn.</p>
            <div className="row-actions"><button type="button" className="btn primary" autoFocus onClick={close}>Done</button></div>
          </>
        ) : (
          <form onSubmit={submit} noValidate={false}>
            <p>Mosshatch isn't open yet. Join and we will email you an invite when it is your turn. <strong>Joining does not reserve or register a name.</strong></p>
            <div className="form-grid">
              <div>
                <label htmlFor="wl-email">Email</label>
                <input id="wl-email" className="text-input" type="email" autoComplete="email" required maxLength={254} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoFocus />
              </div>
              <div>
                <label htmlFor="wl-name">The name you hatched (optional)</label>
                <input id="wl-name" className="text-input" type="text" autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={80} placeholder="moonfern.com" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </div>
              <fieldset className="wl-question">
                <legend>{QUESTION_TEXT} (optional)</legend>
                {(["yes", "no", "maybe"] as const).map((a) => (
                  <label key={a} className="wl-radio"><input type="radio" name="wl-answer" value={a} checked={f.answer === a} onChange={() => setF({ ...f, answer: a })} /> {a[0]!.toUpperCase() + a.slice(1)}</label>
                ))}
              </fieldset>
              <div className="hp" aria-hidden="true">
                <label htmlFor="wl-website">Leave this empty</label>
                <input id="wl-website" type="text" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} />
              </div>
              <label className="check"><input type="checkbox" required checked={f.consent} onChange={(e) => setF({ ...f, consent: e.target.checked })} /> <span>{CONSENT_TEXT}</span></label>
            </div>
            <p className="fineprint">We keep your email, the name you typed and your answer, only to run the waitlist and to learn what people want. We never sell them. Unconfirmed sign-ups are deleted after 30 days, and every email has a one-click leave link. <a href="/waitlist-privacy" target="_blank" rel="noreferrer">Waitlist privacy note (draft awaiting counsel)</a>.</p>
            {err && <p role="alert" className="notice">{err}</p>}
            <div className="row-actions">
              <button type="submit" className="btn primary" disabled={busy}>{busy ? "Joining" : "Join the waitlist"}</button>
              <button type="button" className="btn secondary" onClick={close}>Not now</button>
            </div>
          </form>
        )}
      </div>
    </dialog>
  );
}
