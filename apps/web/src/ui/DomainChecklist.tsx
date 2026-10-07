import { useEffect, useState } from "react";
import { getDns, type DomainDetail, type Security } from "../lib/domains";

type Go = (tab: "overview" | "dns" | "gate") => void;

/**
 * Getting started with a new domain (docs/AUDIT-2026-10-07.md O1, O2, O3): three things a new owner should do, each ticked from what the
 * server reports, never from a click alone. Shown for a name's first 60 days; after that only while the registrant email (the one step
 * the registry enforces) is still unconfirmed.
 */
export function DomainChecklist({ d, sec, go }: { d: DomainDetail; sec: Security | null; go: Go }) {
  const [records, setRecords] = useState<number | null>(null);
  const [open, setOpen] = useState(true);
  useEffect(() => {
    let active = true;
    void getDns(d.fqdn).then((v) => { if (active) setRecords(v.records.length); }).catch(() => { if (active) setRecords(null); });
    return () => { active = false; };
  }, [d.fqdn]);
  const verification = sec?.registrant_verification ?? null;
  const verified = !verification || verification.state === "verified";
  const deadline = verification?.deadline_at ? new Date(verification.deadline_at).toLocaleDateString(undefined, { month: "long", day: "numeric" }) : null;
  const elsewhere = !d.dns_hosted_here;
  const connected = elsewhere || (records ?? 0) > 0;
  const renewalChosen = d.auto_renew;
  const steps = [
    {
      id: "contact", done: verified, title: "Confirm your registrant email",
      body: verified ? "Your contact email is confirmed." : `ICANN rules need the registrant email confirmed${deadline ? ` by ${deadline}` : " within 15 days"}, or the registry can suspend the name.`,
      action: verified ? null : { label: "Confirm it now", run: () => go("dns") },
    },
    {
      id: "connect", done: connected, title: "Connect a website or email",
      body: connected
        ? (elsewhere ? "The name points to nameservers you chose." : "The name has DNS records pointing somewhere.")
        : "Your domain is the name. A website and email are separate services the name points to: add the DNS records your website host or email provider gives you.",
      action: connected ? null : { label: "Open DNS", run: () => go("dns") },
    },
    {
      id: "renew", done: renewalChosen, title: "Choose how it renews",
      body: renewalChosen
        ? "On. We email you before every charge."
        : `Turn auto-renew on below, or renew it yourself before ${d.expires_at ? new Date(d.expires_at).toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" }) : "it expires"}. If you saved a card at checkout, turning it on takes one passkey approval.`,
      action: null,
    },
  ];
  const done = steps.filter((s) => s.done).length;
  if (d.age_days > 60 && verified) return null;
  return (
    <section className="section checklist" aria-labelledby="gs-h">
      <div className="checklist-head">
        <h3 id="gs-h">Getting started</h3>
        <span className="fineprint" aria-live="polite">{done} of {steps.length} done</span>
        <button type="button" className="text-btn" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"}</button>
      </div>
      {open && (
        <>
          <ol className="checklist-steps">
            {steps.map((s) => (
              <li key={s.id} className={s.done ? "done" : ""}>
                <span className="checklist-mark" aria-hidden="true">{s.done ? "✓" : ""}</span>
                <div>
                  <strong>{s.title}</strong><span className="sr-only">{s.done ? " (done)" : " (to do)"}</span>
                  <p className="fineprint">{s.body}</p>
                  {s.action && <button type="button" className="link-btn" onClick={s.action.run}>{s.action.label}</button>}
                </div>
              </li>
            ))}
          </ol>
          <details className="explainer">
            <summary>Domain, website and email: what's what?</summary>
            <ul className="fineprint">
              <li><strong>Domain</strong> (what you bought here): the name and its DNS settings. Mosshatch registers it and keeps it renewed.</li>
              <li><strong>Website</strong>: hosted by a site builder or host you choose. It gives you DNS records (often an A or CNAME record) to add on the DNS tab.</li>
              <li><strong>Email</strong>: run by an email provider you choose. It gives you MX and TXT records to add on the DNS tab.</li>
              <li>Mosshatch does not host websites or mailboxes, and nothing is added to your domain without you.</li>
            </ul>
          </details>
          <p className="fineprint">Optional: <a href="https://hatchglow.com/" target="_blank" rel="noopener noreferrer">Hatchglow</a>, our sister product, can turn your name into a small browser app. It is separate from your domain and needs its own account.</p>
        </>
      )}
    </section>
  );
}
