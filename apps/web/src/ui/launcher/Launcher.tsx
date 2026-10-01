import { useCallback, useEffect, useRef, useState } from "react";
import { deriveCreatureSpec } from "@mosshatch/core";
import { useUi } from "../../store";
import { handle } from "../../world/handle";
import { useNarrow } from "../Find";
import { isDemo } from "../../lib/site";
import { credits, explainLauncher, launcherStatus, openConversation, type Conversation as Conv, type Status } from "../../lib/launcher";
import { Conversation } from "./Conversation";
import { Teaser } from "./Teaser";
import "./launcher.css";

/**
 * The brand launcher (docs/LAUNCHER.md), a lazy chunk with its own stylesheet: talk to a domain's creature, approve a brief, watch the
 * builder, iterate by talking. Accounts without the launcher (signed out, not invited, flag off) get the teaser, which never calls
 * the model. The panel sits beside the creature on wide screens and is a bottom sheet on phones.
 */
export default function Launcher() {
  const { talk, account, apiReady, calm, set } = useUi();
  const narrow = useNarrow();
  const [status, setStatus] = useState<Status | null>(null);
  const [conv, setConv] = useState<Conv | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const domain = talk?.domain ?? "";
  const name = deriveCreatureSpec(domain || "x.com").speciesName;

  const close = useCallback(() => set({ talk: null }), [set]);

  useEffect(() => {
    if (!talk) return;
    let dead = false;
    setStatus(null); setConv(null); setErr(null);
    void (async () => {
      // Only an account the server says may talk ever reaches the conversation routes.
      let s: Status = { access: false, reason: "unauthorized" };
      if (account?.launcher) { try { s = await launcherStatus(); } catch { s = { access: false, reason: "launcher_not_configured" }; } }
      if (dead) return;
      setStatus(s);
      if (!s.access) return;
      try { const c = await openConversation(talk.domain, talk.source); if (!dead) setConv(c); }
      catch (e) { if (!dead) setErr(explainLauncher(e)); }
    })();
    return () => { dead = true; };
  }, [talk, account?.launcher]);

  // Frame the creature beside the panel and keep it still while it talks.
  useEffect(() => {
    if (!domain) return;
    let tries = 0, t = 0;
    // Wide: the creature stands left of the panel. Phone: it stands above the bottom sheet.
    const focus = () => { if (!handle.world?.focusCreature(domain, narrow ? 0 : 0.9, narrow ? -0.75 : 0) && tries++ < 20) t = window.setTimeout(focus, 150); };
    focus();
    return () => { window.clearTimeout(t); handle.world?.releaseCreature(domain); handle.world?.setView(useUi.getState().view === "find" ? "find" : "grove"); };
  }, [domain, narrow]);

  useEffect(() => { head.current?.focus(); }, [domain]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") close(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [close]);

  if (!talk) return null;
  const real = status?.access === true;
  return (
    <aside className={`lx${narrow ? " is-sheet" : ""}`} data-calm={calm ? "1" : "0"} role="region" aria-label={`Talk to ${name}`}>
      <div className="lx-head">
        <h2 ref={head} tabIndex={-1}>{name}<span className="lx-domain">{domain}</span></h2>
        {real && <p className="lx-balance" aria-live="polite">{credits(status.balance_minor)}</p>}
        {real && conv?.source === "practice" && <p className="lx-fine lx-practice">Practice: you don't own {domain}, so the site can't be published there. Builds still cost credits.</p>}
        <button type="button" className="lx-close" onClick={close} aria-label="Close the conversation">×</button>
      </div>
      <div className="lx-body">
        {!status && <p role="status" className="lx-fine">{name} is waking up.</p>}
        {status && !status.access && <Teaser domain={domain} name={name} reason={status.reason} demo={isDemo(apiReady)} onClose={close} />}
        {err && <p className="lx-warn" role="alert">{err}</p>}
        {real && conv && <Conversation key={conv.id} initial={conv} status={status} onBalance={(n) => setStatus((s) => (s && s.access ? { ...s, balance_minor: n } : s))} />}
      </div>
    </aside>
  );
}
