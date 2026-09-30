import { useEffect, useRef, useState } from "react";
import type { StepUpType } from "../lib/domains";
import { ago, approveDns, decide, decline, explainVisitor, getCard, payNow, resolveScope, usd, when, widenToken, type Card } from "../lib/visitors";
import { StepUp, type StepUpRequest } from "./StepUp";

const REASON: Record<string, string> = {
  over_threshold: "the most it can cost is above the amount you set",
  first_approval: "this is the first request you approve for this token",
  new_extension: "you have not bought this extension before",
};

/**
 * The approval card (threat row 18). Everything here comes from the server as plain values and is rendered as text: the
 * requester is the token name you chose; nothing the agent wrote is shown. Reached only from the Visitors view, never by a
 * link in an email. Approving signs exactly these facts with your passkey; it charges nothing: you pay on Stripe next.
 */
export default function ApprovalCard({ id, currentScopes, onClose, onDone }: { id: string; currentScopes: string[]; onClose: () => void; onDone: (msg: string) => void }) {
  const [card, setCard] = useState<Card | null>(null);
  const [typed, setTyped] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  useEffect(() => { getCard(id).then(setCard).catch((e) => setMsg(explainVisitor(e))); }, [id]);
  useEffect(() => { if (card) head.current?.focus(); }, [card]);

  if (!card) return <section className="section" aria-label="Request">{msg ? <p role="alert" className="notice">{msg}</p> : <p role="status">Loading.</p>}</section>;
  const d = card.domain;
  const typedOk = !card.confirm?.required || (!!d && [d.ascii, d.unicode].includes(typed.trim().toLowerCase().replace(/\.$/, "")));

  const approve = () => {
    setMsg(null);
    if (card.kind === "register" || card.kind === "renew") {
      setReq({
        type: "agent.purchase.approve" as StepUpType, target: card.id, input: card.confirm?.required ? { typed_domain: typed.trim() } : {},
        run: async (actionId) => { const r = await decide(card.id, actionId); if (r.checkout_url) location.assign(r.checkout_url); else onDone("Approved. Pay from the list when you are ready."); },
      });
    } else if (card.kind === "dns_change") {
      setReq({ type: "dns.sensitive.approve" as StepUpType, target: `ar_${card.id}`, run: async (actionId) => { await approveDns(card.id, actionId); onDone("Approved. The DNS change is written."); } });
    } else {
      const scopes = [...new Set([...currentScopes, ...(card.scopes ?? [])])];
      setReq({ type: "agent.token.widen" as StepUpType, target: card.requester.binding_id, input: { scopes }, run: async (actionId) => { await widenToken(card.requester.binding_id, actionId); await resolveScope(card.id); onDone("Approved. The token can now do that."); } });
    }
  };
  const no = async () => { try { await decline(card.id); onDone("Declined. Nothing happens."); } catch (e) { setMsg(explainVisitor(e)); } };
  const pay = async () => { try { const r = await payNow(card.id); if (r.checkout_url) location.assign(r.checkout_url); else setMsg("This payment is already under way."); } catch (e) { setMsg(explainVisitor(e)); } };

  const title = card.kind === "register" ? "Register a name" : card.kind === "renew" ? "Renew a name" : card.kind === "dns_change" ? "Change DNS records" : "Give a token more access";
  return (
    <section className="section approval-card" aria-labelledby="card-h">
      <h3 id="card-h" ref={head} tabIndex={-1}>{title}</h3>
      <dl className="facts">
        <div><dt>Asked by your token</dt><dd>{card.requester.name}{card.requester.connected_app ? " (a connected app)" : ""}</dd></div>
        {d && <div><dt>Name</dt><dd><span className="name-big">{d.unicode}</span>{d.has_unicode ? <> (written as <code>{d.ascii}</code>)</> : null}</dd></div>}
        {d?.mixed_script && <div><dt>Warning</dt><dd><strong>This name mixes alphabets. It may be made to look like another name.</strong></dd></div>}
        {card.years && <div><dt>Term</dt><dd>{card.years} {card.years === 1 ? "year" : "years"}</dd></div>}
        {card.first_charge && <div><dt>{card.kind === "renew" ? "Renewal" : "First year"}</dt><dd className="price-equal">{usd(card.first_charge.subtotal_minor)}</dd></div>}
        {card.renewal && <div><dt>Renews at</dt><dd className="price-equal">{usd(card.renewal.subtotal_minor)} for {card.renewal.years} {card.renewal.years === 1 ? "year" : "years"}</dd></div>}
        {card.first_charge && <div><dt>The most you can be charged, including tax</dt><dd>{usd(card.first_charge.max_total_minor)}</dd></div>}
        {card.spend && <div><dt>This token has spent</dt><dd>{usd(card.spend.spent_minor)} of {usd(card.spend.cap_minor)}, with {usd(card.spend.reserved_minor)} held for waiting requests</dd></div>}
        <div><dt>Token expires</dt><dd>{when(card.requester.token_expires_at)}</dd></div>
        <div><dt>Asked</dt><dd>{ago(card.age_seconds)}{card.new_network ? ", from a network this token has not used before" : ""}</dd></div>
        <div><dt>Request expires</dt><dd>{when(card.expires_at)}</dd></div>
      </dl>
      {card.dns && (
        <>
          <h4>Records it adds</h4>
          <ul className="plain">{card.dns.added.map((r, i) => <li key={`a${i}`}><code>{r.type} {r.name} {r.priority ?? ""} {r.value}</code></li>)}</ul>
          <h4>Records it removes</h4>
          {card.dns.removed.length ? <ul className="plain">{card.dns.removed.map((r, i) => <li key={`r${i}`}><code>{r.type} {r.name} {r.value}</code></li>)}</ul> : <p>None.</p>}
          <p>These records control mail, certificates or where the name points: {card.dns.sensitive.map((s) => `${s.type} ${s.name}`).join(", ")}.</p>
        </>
      )}
      {card.scopes && (<><h4>Access it asks for</h4><ul className="plain">{card.scopes.map((s) => <li key={s}><code>{s}</code></li>)}</ul></>)}
      {msg && <p role="alert" className="notice">{msg}</p>}
      {card.state === "pending" && !req && (
        <>
          {card.confirm?.required && d && (
            <div className="form-grid">
              <label htmlFor="typed-name">Type the name to approve it</label>
              <input id="typed-name" className="text-input" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} aria-describedby="typed-why" />
              <p id="typed-why" className="fineprint">Asked because {card.confirm.reasons.map((r) => REASON[r] ?? r).join(", and ")}.</p>
            </div>
          )}
          {(card.kind === "register" || card.kind === "renew") && <p>You pay on Stripe next. Nothing is charged until you do.</p>}
          <div className="row-actions">
            <button type="button" className="btn primary" disabled={!typedOk || !card.requester.live} onClick={approve}>Approve</button>
            <button type="button" className="btn secondary" onClick={() => void no()}>Decline</button>
            <button type="button" className="btn secondary" onClick={onClose}>Back</button>
          </div>
        </>
      )}
      {req && <StepUp req={req} onDone={() => setReq(null)} />}
      {card.state === "approved" && card.agent_state === "approved_awaiting_payment" && (
        <div className="row-actions"><button type="button" className="btn primary" onClick={() => void pay()}>Pay on Stripe</button><button type="button" className="btn secondary" onClick={onClose}>Back</button></div>
      )}
      {card.state !== "pending" && card.state !== "approved" && <div className="row-actions"><button type="button" className="btn secondary" onClick={onClose}>Back</button></div>}
    </section>
  );
}
