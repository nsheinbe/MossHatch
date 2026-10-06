import { useCallback, useEffect, useRef, useState } from "react";
import { useUi, type Result } from "../store";
import { handle } from "../world/handle";
import { search, searchLive } from "../lib/find";
import { sound } from "../audio/synth";
import { Chip } from "./Chips";
import { useArrivalDemo } from "./demo";
import { isDemo } from "../lib/site";

const narrowQuery = "(max-width: 720px)";

export function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia(narrowQuery).matches);
  useEffect(() => {
    const m = matchMedia(narrowQuery);
    const f = () => setNarrow(m.matches);
    m.addEventListener("change", f);
    return () => m.removeEventListener("change", f);
  }, []);
  return narrow;
}

export function Find() {
  const { query, results, alternatives, demo, dealOpen, hatchPhase, apiReady, set } = useUi();
  const narrow = useNarrow();
  const preview = isDemo(apiReady);
  const token = useRef(0);
  const timer = useRef<number>(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { if (handle.world) handle.world.overlayMode = narrow ? "list" : "project"; }, [narrow]);

  const run = useCallback(async (q: string) => {
    const my = ++token.current;
    let r: Awaited<ReturnType<typeof search>>;
    try { r = useUi.getState().apiReady ? await searchLive(q) : await search(q); }
    catch { if (my === token.current) set({ checking: false }); return; }   // throttled or offline: keep what is on screen
    if (my !== token.current) return; // stale
    const w = handle.world;
    if (!r) { set({ results: [], alternatives: [], checking: false }); w?.clearResults(); return; }
    set({ results: r.results, alternatives: r.alternatives, checking: false });
    // A name the registry could not be asked about is neither an egg nor a sleeper: it is only listed, as "couldn't check".
    w?.setResults(r.results.filter((x) => x.status !== "unknown").map((x) => ({ domain: x.domain, available: x.available })));
  }, [set]);

  // Every change of the query (typed or demo-typed) runs a search after a short pause.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    window.clearTimeout(timer.current);
    if (!query.trim()) { token.current++; set({ results: [], alternatives: [], checking: false }); handle.world?.clearResults(); return; }
    set({ checking: true });
    timer.current = window.setTimeout(() => void run(query), 220);
    return () => window.clearTimeout(timer.current);
  }, [query, run, set]);

  useArrivalDemo(inputRef);

  const onPick = (r: Result) => { set({ selected: r, hatchPhase: "sheet" }); };

  const list = narrow;
  let ai = 0;
  const chip = (r: Result, inList: boolean) => <Chip key={r.domain} r={r} list={inList} row={r.available ? ai++ % 2 : 0} onPick={onPick} />;
  const checked = results.filter((r) => r.status !== "unknown"), unchecked = results.filter((r) => r.status === "unknown");
  const hiding = hatchPhase === "hatching";
  // Rescue: a taken name may be the person's own at another registrar (the pre-check says whether it can move).
  const rescuable = alternatives.length === 0 ? results.find((r) => !r.available) : undefined;

  return (
    <main className={`find${results.length ? " has-results" : ""}`} style={hiding ? { visibility: "hidden" } : undefined}>
      <div className="hero">
        <h1>Every name hatches.</h1>
        <p>Find a domain. Hatch its creature. Give your next idea a little life.</p>
        <a className="hero-guide" href="/how-it-works">How Mosshatch works</a>
      </div>

      {list
        ? <div className="chips-list" aria-label="Results">{results.map((r) => chip(r, true))}</div>
        : <>{checked.map((r) => chip(r, false))}{unchecked.length > 0 && <div className="chips-list" aria-label="Not checked">{unchecked.map((r) => chip(r, true))}</div>}</>}

      {alternatives.length > 0 && (
        <div className="alternatives" role="group" aria-label="Open alternatives">
          <p className="lead">That name is taken. These are open:</p>
          {alternatives.map((a) => (
            <button key={a} type="button" className="link-btn" onClick={() => set({ query: a.slice(0, a.indexOf(".")) })}>{a}</button>
          ))}
        </div>
      )}

      {dealOpen && (
        <div className="panel deal" role="region" aria-label="The deal">
          <div className="head"><h2>The deal</h2></div>
          <div className="body">
            <p>One flat price per year. It is what the registry charges plus one small fee, and it renews at the same price.</p>
            <p>WHOIS privacy is free. No add-ons. Nothing is pre-checked.</p>
            <p className="notice">{preview ? "Whether a name is already registered comes from the public registry. Prices are set at launch. In this preview nothing is registered, reserved or charged." : "Prices here are sample prices for this preview."}</p>
            <button type="button" className="btn secondary" onClick={() => set({ dealOpen: false })}>Got it</button>
          </div>
        </div>
      )}

      <form className="pool-input" role="search" onSubmit={(e) => e.preventDefault()}>
        <label htmlFor="name-input">What will you name it?</label>
        <div className="field">
          <input
            id="name-input" ref={inputRef} type="text" value={query} autoComplete="off" autoCapitalize="none" spellCheck={false}
            inputMode="url" maxLength={70} placeholder="moonfern"
            onChange={(e) => { set({ query: e.target.value }); handle.world?.keystroke(); sound.drop(); }}
          />
          <button type="button" className="link-btn" aria-expanded={dealOpen} onClick={() => set({ dealOpen: !dealOpen })}>The deal</button>
        </div>
        {apiReady && rescuable && (
          <div className="rescue-offer" role="group" aria-label="Bring a name you own">
            <span>Already yours at another registrar?</span>
            <button type="button" className="link-btn" onClick={() => set({ rescue: { fqdn: rescuable.domain, transferId: null } })}>Transfer {rescuable.domain} here</button>
          </div>
        )}
        <p className="search-note">{apiReady ? "We check names with our registrar, never register one because you searched, and never sell your searches." : "To check whether a name is taken, we ask the public registry. We don't log or sell your searches."} <a href="/commitments.html">Our commitments</a> · <a href="/fees.html">Fees</a> · <a href="/legal/index.html">Legal</a> · <a href="/report.html">Report abuse</a></p>
      </form>

      {demo === "playing" && <p className="demo-note" role="status">Demo: watching “moonfern” hatch. Type to try your own.</p>}
    </main>
  );
}
