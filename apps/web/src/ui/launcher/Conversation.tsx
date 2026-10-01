import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUi } from "../../store";
import { handle } from "../../world/handle";
import { useAnchor } from "../Chips";
import {
  cancelBuild, confirmBuild, creatureTrouble, explainLauncher, newKey, pollBuild, quote, talk,
  type Build, type Conversation as Conv, type Line, type Proposal, type Status, type TurnEvent,
} from "../../lib/launcher";
import { TokenAmplitude, driveGlow } from "../../voice/amplitude";
import { BriefCard, BuildProgress, FailedBuild, Preview, type PriceState } from "./Scroll";

type Access = Extract<Status, { access: true }>;
const POLL_MS = 1200;

/**
 * The conversation with one creature. Captions are the transcript (a polite log; each reply is announced once, when it is complete);
 * the live words also float in a speech bubble at the creature's head. The creature's glow follows the streamed words.
 */
export function Conversation({ initial, status, onBalance }: { initial: Conv; status: Access; onBalance(n: number): void }) {
  const calm = useUi((s) => s.calm);
  const [conv, setConv] = useState(initial);
  const [lines, setLines] = useState<Line[]>(initial.transcript);
  const [live, setLive] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [price, setPrice] = useState<PriceState | null>(null);
  const [builds, setBuilds] = useState<Build[]>(initial.builds);
  const [selected, setSelected] = useState<string | null>(null);
  const [announce, setAnnounce] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const keys = useRef(new Map<string, string>());
  /** A turn that brought a scroll moves focus to it (its heading); any other turn returns focus to the input. */
  const proposed = useRef(false);
  /** Turns started; a late frame from an earlier turn must not pull focus off a newer turn's scroll. */
  const turns = useRef(0);
  const name = conv.species_name;
  const domain = conv.domain;

  const proposals = conv.proposals;
  const latest: Proposal | undefined = proposals[proposals.length - 1];
  const ready = useMemo(() => builds.filter((b) => b.status === "ready" && b.version).sort((a, b) => a.version! - b.version!), [builds]);
  const inflight = builds.find((b) => b.status === "queued" || b.status === "building");
  const latestBuild = latest?.build_id ? builds.find((b) => b.id === latest.build_id) : undefined;
  const showing = ready.find((b) => b.id === selected) ?? ready[ready.length - 1];
  const openProposal = latest && ["proposed", "quoted", "refused", "failed"].includes(latest.state) && !(latestBuild && ["queued", "building"].includes(latestBuild.status)) ? latest : undefined;

  // The speech bubble rides on the creature's head (projected each frame by the world).
  const bubble = useAnchor(`talk:${domain}`, false);
  const lastCreature = [...lines].reverse().find((l) => l.who === "creature");
  const bubbleText = live ?? lastCreature?.text ?? "";

  const scrollDown = () => requestAnimationFrame(() => logEnd.current?.scrollIntoView({ block: "end", behavior: calm ? "auto" : "smooth" }));

  const onEvent = useCallback((e: TurnEvent, amp: TokenAmplitude) => {
    if (e.type === "text") { amp.push(e.d, performance.now()); setLive((x) => (x ?? "") + e.d); scrollDown(); }
    else if (e.type === "brief" || e.type === "revision") {
      proposed.current = true;
      setConv((c) => ({ ...c, proposals: [...c.proposals, e.proposal] }));
      handle.world?.goldSparks(domain);
      setAnnounce(e.type === "brief" ? `${name} wrote a brief. It's on the scroll below.` : `${name} proposed a change. It's on the scroll below.`);
    } else if (e.type === "refusal") { setLive(null); setAnnounce(e.line); }
    else if (e.type === "error") { setLive(null); setNotice(creatureTrouble(name, e.code)); }
    else if (e.type === "done") { setLive(null); setLines(e.transcript); const last = e.transcript[e.transcript.length - 1]; if (last?.who === "creature" && last.text) setAnnounce(`${name}: ${last.text}`); if (proposed.current) requestAnimationFrame(() => document.querySelector(".lx-unfurl")?.scrollIntoView({ block: "start" })); else scrollDown(); }
  }, [domain, name, calm]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = useCallback(async (words: string) => {
    setBusy(true); setNotice(null);
    if (words) setLines((l) => [...l, { who: "owner", text: words, at: new Date().toISOString() }]);
    setLive("");
    proposed.current = false;
    const turnNo = ++turns.current;
    const amp = new TokenAmplitude();
    const stop = driveGlow(amp, (lvl) => handle.world?.setVoice(domain, lvl));
    try { await talk(conv.id, words, (e) => onEvent(e, amp)); }
    catch (e) { setLive(null); setNotice(explainLauncher(e)); if (words) setLines((l) => l.slice(0, -1)); if (words) setText(words); }
    finally { stop(); setBusy(false); setConv((c) => ({ ...c, started: true })); if (!proposed.current) requestAnimationFrame(() => { if (turns.current === turnNo && !proposed.current) input.current?.focus(); }); }
  }, [conv.id, domain, onEvent]);

  // The creature speaks first.
  const greeted = useRef(false);
  useEffect(() => { if (!conv.started && !greeted.current) { greeted.current = true; void send(""); } }, [conv.started, send]);
  useEffect(() => { scrollDown(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Price for the open proposal: asked once when it appears (quotes are free; nothing is charged).
  const askPrice = useCallback(async (p: Proposal) => {
    setPrice({ proposalId: p.id, asking: true });
    try {
      const base = p.kind === "revision" && showing && showing.id !== p.base_build_id ? showing.id : undefined;
      const q = await quote(p.id, base);
      setPrice({ proposalId: p.id, asking: false, quote: q });
      onBalance(q.balance_minor);
    } catch (e) {
      setPrice({ proposalId: p.id, asking: false, error: explainLauncher(e) });
      if ((e as { code?: string }).code === "brief_refused") setConv((c) => ({ ...c, proposals: c.proposals.map((x) => (x.id === p.id ? { ...x, state: "refused" } : x)) }));
    }
  }, [onBalance, showing]);
  useEffect(() => {
    if (openProposal && openProposal.state !== "refused" && price?.proposalId !== openProposal.id) void askPrice(openProposal);
  }, [openProposal, price?.proposalId, askPrice]);

  const approve = async () => {
    const q = price?.quote;
    if (!q || !openProposal) return;
    // One key per quote: a retried press is the same build, charged once.
    const key = keys.current.get(q.quote.id) ?? newKey();
    keys.current.set(q.quote.id, key);
    setNotice(null);
    try {
      const r = await confirmBuild(q.quote.id, key);
      onBalance(r.balance_minor);
      setBuilds((bs) => [...bs.filter((b) => b.id !== r.build.id), r.build]);
      setConv((c) => ({ ...c, proposals: c.proposals.map((x) => (x.id === openProposal.id ? { ...x, state: "building", build_id: r.build.id } : x)) }));
      setPrice(null);
      setAnnounce(`Approved. The builder has started. ${q.quote.price_minor} credits were charged.`);
    } catch (e) { setNotice(explainLauncher(e)); if ((e as { code?: string }).code === "quote_expired") setPrice(null); }
  };

  // Poll the build in flight; the server asks Slate and refunds on failure.
  useEffect(() => {
    if (!inflight) return;
    let dead = false;
    const t = window.setInterval(async () => {
      try {
        const r = await pollBuild(inflight.id);
        if (dead) return;
        setBuilds((bs) => bs.map((b) => (b.id === r.build.id ? r.build : b)));
        onBalance(r.balance_minor);
        if (r.build.status === "ready") {
          setSelected(r.build.id);
          handle.world?.goldSparks(domain);
          setAnnounce(`Version ${r.build.version} is ready. The preview is on the scroll.`);
        } else if (["failed", "refunded", "canceled"].includes(r.build.status)) setAnnounce(`The build stopped. Your ${r.build.price_minor} credits are back.`);
      } catch { /* the next tick tries again */ }
    }, POLL_MS);
    return () => { dead = true; window.clearInterval(t); };
  }, [inflight?.id, domain, onBalance]); // eslint-disable-line react-hooks/exhaustive-deps

  // Slate's preview links are signed for 10 minutes: read the shown version again when it is chosen and every 8.5 minutes after
  // (the server asks Slate only when the link it holds is 8 minutes old).
  useEffect(() => {
    if (!showing) return;
    const refresh = async () => { try { const r = await pollBuild(showing.id); setBuilds((bs) => bs.map((b) => (b.id === r.build.id ? r.build : b))); } catch { /* keep the old link */ } };
    void refresh();
    const t = window.setInterval(refresh, 510_000);
    return () => window.clearInterval(t);
  }, [showing?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const stopBuild = async (b: Build) => {
    try { const r = await cancelBuild(b.id); setBuilds((bs) => bs.map((x) => (x.id === r.build.id ? r.build : x))); onBalance(r.balance_minor); }
    catch (e) { setNotice(explainLauncher(e)); }
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const words = text.trim();
    if (!words || busy) return;
    setText("");
    void send(words);
  };
  const change = () => { setText(""); input.current?.focus(); input.current?.setAttribute("placeholder", `Tell ${name} what to change`); };
  const failed = latestBuild && ["failed", "refunded", "canceled"].includes(latestBuild.status) ? latestBuild : undefined;

  return (
    <>
      {/* In a portal: the panel's own transform would otherwise become the bubble's frame instead of the viewport. */}
      {createPortal(
        <div ref={bubble as React.RefObject<HTMLDivElement>} className={`lx-bubble${live !== null ? " is-speaking" : ""}${bubbleText ? "" : " is-empty"}${calm ? " is-calm" : ""}`} aria-hidden="true">
          <span>{bubbleText.length > 160 ? bubbleText.slice(0, 157) + "…" : bubbleText || "…"}</span>
        </div>, document.body)}
      <div className="lx-log" role="log" aria-label={`Conversation with ${name}`} aria-busy={busy}>
        {lines.map((l, i) => (
          <p key={i} className={`lx-line is-${l.who}${l.refusal ? " is-refusal" : ""}`}>
            <span className="lx-who">{l.who === "owner" ? "You" : name}</span>
            <span className="lx-said">{l.text}</span>
          </p>
        ))}
        {live !== null && (
          <p className="lx-line is-creature is-live" aria-hidden="true">
            <span className="lx-who">{name}</span>
            <span className="lx-said">{live}<span className="lx-caret" /></span>
          </p>
        )}
        <div ref={logEnd} />
      </div>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      {openProposal?.brief && <BriefCard brief={openProposal.brief} proposal={openProposal} name={name} price={price?.proposalId === openProposal.id ? price : null} building={false} onApprove={() => void approve()} onChange={change} onRetryPrice={() => void askPrice(openProposal)} />}
      {inflight && <BuildProgress build={inflight} onCancel={() => void stopBuild(inflight)} />}
      {failed && !inflight && !openProposal && <FailedBuild build={failed} />}
      {showing && <Preview versions={ready} selected={showing} onSelect={setSelected} domain={domain} framing={status.preview_framing} />}
      {notice && <p className="lx-warn lx-notice" role="alert">{notice}</p>}
      <form className="lx-say" onSubmit={submit}>
        <label htmlFor="lx-input" className="sr-only">Say something to {name}</label>
        <textarea id="lx-input" ref={input} rows={2} maxLength={1000} value={text} disabled={busy && !conv.started} placeholder={busy ? `${name} is speaking…` : `Say something to ${name}`}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (e.currentTarget.form as HTMLFormElement).requestSubmit(); } }} />
        <button type="submit" className="lx-btn lx-send" disabled={busy || !text.trim()}>Say it</button>
      </form>
    </>
  );
}
