import { useCallback, useEffect, useRef, useState } from "react";
import { useUi, type Result } from "../store";
import { handle } from "../world/handle";
import { parseQuery, search, searchLive, staticPrices } from "../lib/find";
import { alternativeNames, nameIdeas } from "../lib/ideas";
import { sound } from "../audio/synth";
import { Chip } from "./Chips";
import { isDemo } from "../lib/site";
import { trackConversion } from "../lib/conversion";

export function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 720px)").matches);
  useEffect(() => { const m = matchMedia("(max-width: 720px)"); const f = () => setNarrow(m.matches); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, []);
  return narrow;
}
export function Find({ simple = false }: { simple?: boolean }) {
  const { query, results, checking, dealOpen, apiReady, hatchPhase, set } = useUi();
  const preview = isDemo(apiReady);
  const token = useRef(0);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"name" | "idea">("name");
  const [idea, setIdea] = useState("");
  const [inspiration, setInspiration] = useState<string[]>([]);
  const [suggestions, setSuggestions] = useState<Result[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionNote, setSuggestionNote] = useState("");
  const suggestionToken = useRef(0);
  const com = staticPrices().find(p => p.tld === "com");
  useEffect(() => { if (handle.world) handle.world.overlayMode = "list"; }, [simple]);
  useEffect(() => { trackConversion("visit", preview); }, [preview]);
  const run = useCallback(async (raw: string) => {
    const mine = ++token.current;
    if (!parseQuery(raw)) { setError("Enter a name using letters, numbers or hyphens."); set({ checking: false, results: [] }); return; }
    setError(""); set({ checking: true });
    trackConversion("search", isDemo(useUi.getState().apiReady));
    try {
      const r = useUi.getState().apiReady ? await searchLive(raw) : await search(raw);
      if (mine !== token.current) return;
      set({ results: r?.results ?? [], checking: false });
      handle.world?.setResults((r?.results ?? []).filter(x => x.status !== "unknown").map(x => ({ domain: x.domain, available: x.available })));
      if (r?.results.some(x => x.available)) trackConversion("available", isDemo(useUi.getState().apiReady));
      if (r?.results.every(x => x.status === "unknown")) setError("We couldn't check these names right now. Please try again shortly.");
    } catch {
      if (mine !== token.current) return;
      set({ checking: false, results: [] }); handle.world?.clearResults();
      setError("Search is temporarily unavailable. Please try again shortly; your name has not been reserved.");
    }
  }, [set]);
  useEffect(() => {
    token.current++; suggestionToken.current++;
    setSuggestions([]); setSuggestionNote(""); setSuggesting(false);
    set({ results: [], checking: !!query.trim() }); handle.world?.clearResults();
    if (!query.trim()) { setError(""); return; }
    const timer = window.setTimeout(() => void run(query), 650);
    return () => { window.clearTimeout(timer); token.current++; };
  }, [query, apiReady, run, set]);
  const pick = (r: Result) => { trackConversion("selected", preview); set({ selected: r, hatchPhase: "sheet" }); };
  const suggest = async () => {
    const mine = ++suggestionToken.current;
    setSuggesting(true); setSuggestionNote(""); setSuggestions([]);
    const found: Result[] = []; let unknown = false;
    for (const label of alternativeNames(query)) {
      if (mine !== suggestionToken.current) return;
      try {
        const r = apiReady ? await searchLive(label, true) : await search(`${label}.com`);
        const result = r?.results.find(x => x.tld === "com");
        if (result?.available) found.push(result);
        if (!result || result.status === "unknown") unknown = true;
      } catch { unknown = true; break; }
    }
    if (mine !== suggestionToken.current) return;
    setSuggestions(found); setSuggesting(false);
    setSuggestionNote(found.length ? "Each suggestion was checked. Availability can change before checkout." : unknown ? "Some checks are unavailable. Try again shortly or search another name." : "Those variations are taken too. Try describing your idea for a fresh direction.");
  };
  const rescuable = results.find(r => r.status === "registered");
  const takenCom = results.find(r => r.tld === "com" && r.status === "registered");
  return (
    <main className={`find shop-find${results.length ? " has-results" : ""}${simple ? " simple-find" : ""}${hatchPhase === "hatching" || hatchPhase === "card" ? " stepping-aside" : ""}`}>
      <div className="shop-intro">
        <span className="eyebrow">A home for your next idea</span>
        <h1>Find your domain.<br /><em>Hatch something wonderful.</em></h1>
        <p>A name you own. A creature that's yours. A little world waiting to begin.</p>
        <div className="shop-promises"><span>Clear renewal pricing</span><span>No preselected extras</span><span>Your domain, your control</span></div>
      </div>
      {simple && <p className="notice">You're using the lightweight view. Search and checkout work without the animated grove.</p>}
      <div className="search-modes" role="group" aria-label="How would you like to find a name?">
        <button type="button" aria-pressed={mode === "name"} onClick={() => setMode("name")}>I have a name</button>
        <button type="button" aria-pressed={mode === "idea"} onClick={() => setMode("idea")}>Describe my idea</button>
      </div>
      {mode === "idea" && <form className="idea-form" onSubmit={e => { e.preventDefault(); setInspiration(nameIdeas(idea)); }}>
        <label htmlFor="idea-input">What are you bringing to life?</label>
        <textarea id="idea-input" className="text-input" value={idea} maxLength={240} placeholder="A ceramics studio inspired by the coast" onChange={e => setIdea(e.target.value)} />
        <button className="btn secondary" type="submit" disabled={!idea.trim()}>Find inspiration</button>
        <p className="fineprint">Ideas are made in your browser. Select one to check availability.</p>
        <div className="idea-names">{inspiration.map(name => <button type="button" className="link-btn" key={name} onClick={() => { set({ query: name }); setMode("name"); }}>{name}.com</button>)}</div>
      </form>}
      <form className="pool-input shop-search" role="search" onSubmit={e => { e.preventDefault(); void run(query); }}>
        <label htmlFor="name-input">What will you name it?</label>
        <div className="field">
          <input id="name-input" type="text" value={query} autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" maxLength={70} placeholder="Your next great name" onChange={e => { set({ query: e.target.value, demo: "done" }); handle.world?.keystroke(); sound.drop(); }} />
          <button type="submit" className="btn primary" disabled={checking || !query.trim()}>Search</button>
        </div>
        <p className="search-status" role="status">{checking ? "Checking availability…" : results.length ? `${results.filter(r => r.available).length} ${preview ? "potential matches" : "available names"} found` : preview && com ? `.com published test price ${com.price} / year. Public launch pricing may change.` : "Start with a name or a domain, like moonfern.com"}</p>
      </form>
      {error && <div className="search-error" role="alert"><p>{error}</p><button className="link-btn" type="button" disabled={checking} onClick={() => void run(query)}>Try again</button></div>}
      {results.length > 0 && <div className="shop-results" aria-label="Results" aria-busy={checking}>{results.map(r => <Chip key={r.domain} r={r} list row={0} onPick={pick} />)}</div>}
      {takenCom && <section className="shop-alternatives" aria-label="Alternative .com names"><p><strong>Your .com taken?</strong> Let's find another way in.</p><button className="btn secondary" type="button" disabled={suggesting} onClick={() => void suggest()}>{suggesting ? "Checking alternatives…" : "Find similar .com names"}</button><div className="shop-results">{suggestions.map(r => <Chip key={r.domain} r={r} list row={0} onPick={pick} />)}</div>{suggestionNote && <p role="status" className="fineprint">{suggestionNote}</p>}</section>}
      {apiReady && rescuable && <div className="rescue-offer" role="group" aria-label="Bring a name you own"><span>Already own {rescuable.domain}?</span><button type="button" className="link-btn" onClick={() => set({ rescue: { fqdn: rescuable.domain, transferId: null } })}>Transfer {rescuable.domain} here</button></div>}
      <div className="shop-links"><button type="button" className="text-btn" aria-expanded={dealOpen} onClick={() => set({ dealOpen: !dealOpen })}>The deal</button><a href="/how-it-works">How it works</a><a href="/fees.html">Prices & renewals</a></div>
      {dealOpen && <section className="shop-deal" aria-label="The deal"><h2>A clear price. A name that's yours.</h2><p>See the registration term and renewal price before checkout. Taxes, if applicable, are shown by Stripe before you confirm.</p><p>Privacy protection is included where the registry supports it. .ai registrant details are public. No add-ons are preselected.</p><p>{preview ? "These are published invite-only test prices. A practice hatch never registers or reserves a domain." : "Availability is checked again before purchase. Your creature hatches after registration is confirmed."}</p><button className="link-btn" type="button" onClick={() => set({ dealOpen: false })}>Got it</button></section>}
      <p className="search-note">We don't sell your searches. <a href="/commitments.html">Our commitments</a> · <a href="/legal/index.html">Legal</a> · <a href="/report.html">Report abuse</a></p>
    </main>
  );
}
