"use client";
import "./GettingStarted.css";

import { useEffect, useId, useRef, useState } from "react";

export type GettingStartedStep = {
  id: string;
  title: string;
  description: string;
  href?: string;
  onAction?: () => void;
  complete?: boolean;
  /** Only for actions the product cannot observe, such as reading a guide. */
  manual?: boolean;
  actionLabel?: string;
};
type Props = {
  storageKey: string;
  steps: GettingStartedStep[];
  description: string;
  title?: string;
  floating?: boolean;
};
type Saved = { version: 1; collapsed: boolean; checked: string[] };

// Remount on identity changes: another person's checklist must never flash or be overwritten.
export function GettingStarted(props: Props) {
  return <Checklist key={props.storageKey} {...props} />;
}

function Checklist({ storageKey, steps, description, title = "Getting started", floating = false }: Props) {
  const id = useId();
  const key = `getting-started:v1:${storageKey}`;
  const [saved, setSaved] = useState<Saved>({ version: 1, collapsed: floating, checked: [] });
  const [ready, setReady] = useState(false);
  const [canSave, setCanSave] = useState(true);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const read = () => {
      try {
        const raw: unknown = JSON.parse(localStorage.getItem(key) || "null");
        if (raw && typeof raw === "object" && "version" in raw && raw.version === 1) {
          const value = raw as Partial<Saved>;
          setSaved({ version: 1, collapsed: typeof value.collapsed === "boolean" ? value.collapsed : floating,
            checked: Array.isArray(value.checked) ? value.checked.filter((s): s is string => typeof s === "string").slice(0, 32) : [] });
        }
      } catch { setCanSave(false); }
      setReady(true);
    };
    read();
    const sync = (event: StorageEvent) => { if (event.key === key) read(); };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, [key, floating]);

  function update(next: Saved) {
    setSaved(next);
    try { localStorage.setItem(key, JSON.stringify(next)); }
    catch { setCanSave(false); }
  }
  const done = (step: GettingStartedStep) => step.complete === true || (step.manual === true && saved.checked.includes(step.id));
  const count = steps.filter(done).length;
  const next = steps.find(step => !done(step));
  const allDone = count === steps.length;
  const collapsed = saved.collapsed;
  function act(step: GettingStartedStep) {
    step.onAction?.();
    if (floating) update({ ...saved, collapsed: true });
  }
  function action(step: GettingStartedStep, primary = false) {
    const label = primary ? "Continue setup" : step.actionLabel || "Open step";
    if (step.href) return <a className={primary ? "gs-primary" : "gs-action"} href={step.href} onClick={() => act(step)} aria-label={`${label}: ${step.title}`}>{label}<span aria-hidden="true"> ↗</span></a>;
    if (step.onAction) return <button type="button" className={primary ? "gs-primary" : "gs-action"} onClick={() => act(step)} aria-label={`${label}: ${step.title}`}>{label}<span aria-hidden="true"> →</span></button>;
    return null;
  }
  if (!steps.length || (floating && !ready)) return null;
  return <section className={`gs-card${floating ? " gs-floating" : ""}${collapsed ? " gs-collapsed" : ""}`} aria-labelledby={`${id}-title`}>
    <div className="gs-heading">
      <div><span className="gs-eyebrow">{allDone ? "A GREAT BEGINNING" : "YOUR NEXT SMALL WIN"}</span><h2 id={`${id}-title`}>{allDone ? "You’re off to a great start" : title}</h2></div>
      <button ref={toggle} type="button" className="gs-toggle" aria-expanded={!collapsed} aria-controls={`${id}-body`} disabled={!ready} onClick={() => update({ ...saved, collapsed: !collapsed })}>{collapsed ? "Show" : "Minimize"}<span aria-hidden="true"> {collapsed ? "+" : "−"}</span></button>
    </div>
    <div className="gs-progress"><progress max={steps.length} value={count} aria-label={`${count} of ${steps.length} getting-started steps complete`} /><span aria-live="polite">{count} of {steps.length}</span></div>
    {collapsed && <p className="gs-summary">{next ? `Up next: ${next.title}` : "Your checklist is here whenever you need it."}</p>}
    <div id={`${id}-body`} hidden={collapsed}>
      <p className="gs-description">{allDone ? "You’ve found your footing. Keep going at your own pace." : description}</p>
      <ol className="gs-list">{steps.map((step, index) => <li key={step.id} className={done(step) ? "gs-done" : step === next ? "gs-next" : ""}>
        <span className="gs-mark" aria-hidden="true">{done(step) ? "✓" : String(index + 1).padStart(2, "0")}</span>
        <div className="gs-step"><strong>{step.title}<span className="gs-sr">{done(step) ? " — complete" : " — not complete"}</span></strong><p>{step.description}</p>
          <div className="gs-controls">{action(step)}{step.manual && !step.complete && <label className="gs-check"><input type="checkbox" checked={saved.checked.includes(step.id)} disabled={!ready} onChange={event => update({ ...saved, checked: event.target.checked ? [...new Set([...saved.checked, step.id])] : saved.checked.filter(value => value !== step.id) })} />I’ve done this<span className="gs-sr">: {step.title}</span></label>}</div>
        </div>
      </li>)}</ol>
      {next && <div className="gs-footer">{action(next, true)}<button type="button" className="gs-later" disabled={!ready} onClick={() => { update({ ...saved, collapsed: true }); toggle.current?.focus(); }}>I’ll explore first</button></div>}
      <p className="gs-note">{!canSave ? "Browser storage is unavailable. Manual checkmarks and display preferences last for this visit." : steps.some(step => step.manual) ? "Completed work updates automatically. Your own checkmarks are saved on this device." : "Progress updates from your saved work. Come back whenever you like."}</p>
    </div>
  </section>;
}

