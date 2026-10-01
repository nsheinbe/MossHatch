import { useEffect, useRef, useState } from "react";
import type { Brief } from "@mosshatch/core/brief";
import { credits, exportUrl, type Build, type Proposal, type Quote } from "../../lib/launcher";
import { Runes } from "./Runes";

/**
 * The scroll: the brief as an illuminated card (Approve shows the price; nothing is charged before the press), the builder's runes
 * while it works, then the preview unrolling with the versions along its edge. Presentational: Conversation owns the calls.
 */

export interface PriceState { proposalId: string; quote?: Quote; asking: boolean; error?: string }

export function BriefCard({ brief, proposal, name, price, building, onApprove, onChange, onRetryPrice }: {
  brief: Brief; proposal: Proposal; name: string; price: PriceState | null; building: boolean;
  onApprove(): void; onChange(): void; onRetryPrice(): void;
}) {
  const head = useRef<HTMLHeadingElement>(null);
  // The scroll takes focus when it unfurls (keyboard and screen-reader users land on the brief) and comes into view.
  useEffect(() => { head.current?.focus({ preventScroll: true }); head.current?.closest("section")?.scrollIntoView({ block: "start" }); }, [proposal.id]);
  const revision = proposal.kind === "revision";
  const q = price?.quote;
  const refused = proposal.state === "refused";
  return (
    <section className="lx-scroll lx-unfurl" aria-labelledby={`brief-${proposal.id}`}>
      <div className="lx-roller" aria-hidden="true" />
      <div className="lx-sheet">
        <p className="lx-kicker">{revision ? `A change ${name} heard` : `What ${name} heard`}</p>
        <h3 id={`brief-${proposal.id}`} ref={head} tabIndex={-1} className="lx-title">{brief.name}</h3>
        {revision ? (
          <p className="lx-oneliner">{proposal.instruction}</p>
        ) : (
          <>
            <p className="lx-oneliner">{brief.oneLiner}</p>
            <dl className="lx-brief">
              <dt>For</dt><dd>{brief.audience}</dd>
              <dt>Goal</dt><dd>{brief.goal}</dd>
              <dt>Pages</dt><dd>{brief.pages.join(", ")}</dd>
              {brief.sections?.length ? <><dt>Sections</dt><dd>{brief.sections.join(", ")}</dd></> : null}
              <dt>Tone</dt><dd>{brief.tone}</dd>
              <dt>Colours</dt>
              <dd>
                <ul className="lx-swatches">
                  {(["primary", "accent", "background", "text"] as const).map((k) => (
                    <li key={k}><span className="lx-swatch" aria-hidden="true" style={{ background: brief.palette[k] }} />{k} <code>{brief.palette[k]}</code></li>
                  ))}
                </ul>
              </dd>
              {brief.notes ? <><dt>Notes</dt><dd>{brief.notes}</dd></> : null}
            </dl>
          </>
        )}
        {refused ? (
          <p className="lx-warn" role="alert">Mosshatch can't build this one: it looks like it imitates a brand or asks people for passwords or payment details. Nothing was charged.</p>
        ) : building ? null : (
          <div className="lx-price" aria-live="polite">
            {price?.asking && <p role="status">Asking the builder for a price.</p>}
            {price?.error && <p className="lx-warn" role="alert">{price.error} <button type="button" className="lx-link" onClick={onRetryPrice}>Ask again</button></p>}
            {q && (
              <>
                <p><strong>{credits(q.quote.price_minor)}</strong> for this {revision ? "change" : "first version"}. Your balance: {credits(q.balance_minor)}.</p>
                <p className="lx-fine">Nothing is charged until you press Approve. If the builder fails, the credits come back.</p>
                {!q.enough && <p className="lx-warn">You don't have enough credits yet. During the invite-only test Mosshatch adds credits for you; buying credits arrives next.</p>}
              </>
            )}
            <div className="lx-actions">
              <button type="button" className="lx-btn lx-approve" disabled={!q || !q.enough} onClick={onApprove}>{q ? `Approve and build for ${q.quote.price_minor.toLocaleString("en-US")} credits` : "Approve"}</button>
              <button type="button" className="lx-btn lx-ghost" onClick={onChange}>Change</button>
            </div>
          </div>
        )}
      </div>
      <div className="lx-roller lx-roller-b" aria-hidden="true" />
    </section>
  );
}

export function BuildProgress({ build, onCancel }: { build: Build; onCancel(): void }) {
  return (
    <section className="lx-scroll" aria-labelledby={`build-${build.id}`}>
      <div className="lx-sheet">
        <h3 id={`build-${build.id}`} className="lx-subtitle">{build.kind === "revision" ? "Building the change" : "Building your first version"}</h3>
        <Runes steps={build.steps} label="Builder steps" />
        <div className="lx-actions"><button type="button" className="lx-btn lx-ghost" onClick={onCancel}>Stop this build</button></div>
      </div>
    </section>
  );
}

export function FailedBuild({ build }: { build: Build }) {
  return (
    <section className="lx-scroll" aria-label="Build stopped">
      <div className="lx-sheet">
        <p className="lx-warn" role="alert">{build.status === "canceled" ? "The build was stopped." : "The builder couldn't finish this one."} Your {build.price_minor.toLocaleString("en-US")} credits are back in your balance.</p>
      </div>
    </section>
  );
}

export function Preview({ versions, selected, onSelect, domain, framing }: { versions: Build[]; selected: Build; onSelect(id: string): void; domain: string; framing: boolean }) {
  const [publish, setPublish] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const box = useRef<HTMLElement>(null);
  // A newly chosen (or newly built) version unrolls into view.
  useEffect(() => { box.current?.scrollIntoView({ block: "start" }); }, [selected.id]);
  const idx = versions.findIndex((v) => v.id === selected.id);
  const prev = idx > 0 ? versions[idx - 1] : undefined;
  useEffect(() => {
    // If the deployed CSP refuses the frame anyway, say so and offer the link (never a blank box).
    const h = (e: SecurityPolicyViolationEvent) => { if (e.violatedDirective.startsWith("frame-src")) setBlocked(true); };
    document.addEventListener("securitypolicyviolation", h);
    return () => document.removeEventListener("securitypolicyviolation", h);
  }, []);
  // The frame keeps the link it opened with (reloading it every refresh would be jarring); it takes a new one when another version is
  // chosen or the one it holds has expired.
  const [src, setSrc] = useState<{ id: string; url: string | null }>({ id: selected.id, url: selected.preview_url ?? null });
  useEffect(() => {
    const exp = Number(new URLSearchParams((src.url ?? "").split("?")[1] ?? "").get("exp") ?? "0");
    if (src.id !== selected.id || (selected.preview_url && (!src.url || (exp && exp * 1000 < Date.now())))) setSrc({ id: selected.id, url: selected.preview_url ?? null });
  }, [selected.id, selected.preview_url, src]);
  const url = src.id === selected.id ? src.url : selected.preview_url ?? null;
  return (
    <section ref={box} className="lx-scroll lx-preview-scroll" aria-labelledby="lx-preview-h">
      <div className="lx-sheet">
        <div className="lx-preview-head">
          <h3 id="lx-preview-h" className="lx-subtitle">{selected.title ?? "Your site"}, version {selected.version}</h3>
          <div className="lx-versions" role="group" aria-label="Versions">
            {versions.map((v) => (
              <button key={v.id} type="button" className="lx-ver" aria-pressed={v.id === selected.id} onClick={() => onSelect(v.id)}>
                <span aria-hidden="true">v{v.version}</span><span className="sr-only">Version {v.version}</span>
              </button>
            ))}
          </div>
        </div>
        {selected.summary && <p className="lx-fine">{selected.summary}</p>}
        {url && framing && !blocked ? (
          <div className="lx-frame lx-unroll">
            <iframe src={url} title={`Preview of ${selected.title ?? "your site"}, version ${selected.version}`} sandbox="allow-scripts" referrerPolicy="no-referrer" loading="lazy" />
          </div>
        ) : url ? (
          <p className="lx-fine">The preview opens on the builder's site. <a href={url} target="_blank" rel="noopener noreferrer">Open the preview of version {selected.version}</a>.</p>
        ) : <p className="lx-fine">The builder did not send a preview for this version.</p>}
        <div className="lx-actions">
          {prev && <button type="button" className="lx-btn lx-ghost" onClick={() => onSelect(prev.id)}>Undo to version {prev.version}</button>}
          <button type="button" className="lx-btn lx-approve" aria-expanded={publish} onClick={() => setPublish((x) => !x)}>Publish to {domain}</button>
        </div>
        {publish && (
          <div className="lx-publish" role="region" aria-label={`Publish to ${domain}`} ref={(el) => el?.scrollIntoView({ block: "nearest" })}>
            <p><strong>Publishing to your domain arrives next.</strong> Nothing has been published, and {domain} does not point at this site.</p>
            <p>Today you can download this version's files and host them yourself.</p>
            <a className="lx-btn lx-ghost" href={exportUrl(selected.id)} download>Download version {selected.version}</a>
          </div>
        )}
      </div>
    </section>
  );
}
