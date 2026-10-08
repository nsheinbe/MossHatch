import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi, type Result } from "../store";
import { handle } from "../world/handle";
import { parseQuery, search, searchLive, staticPrices } from "../lib/find";
import { loadShortlist, saveShortlist, SHORTLIST_MAX, toggleShortlist } from "../lib/shortlist";
import { sound } from "../audio/synth";
import { Chip } from "./Chips";
import { isDemo } from "../lib/site";
import { trackConversion } from "../lib/conversion";

/** How many idea names, and how many close variations of a taken name, are checked per request: each is one lookup per extension. */
const IDEA_CHECKS = 6, SIMILAR_CHECKS = 6;

/** The extension to offer for an idea when several are free: .com first, then one the brief itself names (a "studio"), then the cheapest a year. */
function bestOf(free: Result[], brief: string): Result | undefined {
  const words = new Set(brief.toLowerCase().match(/[a-z]+/g) ?? []);
  const rank = (r: Result) => (r.tld === "com" ? 0 : words.has(r.tld) ? 1 : 2);
  const perYear = (r: Result) => { const n = Number((r.price ?? "").replace(/[^0-9.]/g, "")); return n > 0 ? n / (r.years ?? 1) : Infinity; };
  return [...free].sort((a, b) => rank(a) - rank(b) || perYear(a) - perYear(b))[0];
}
const per = (r: Result) => (r.years === 2 ? " / 2 years" : " / year");
const notBuyable = (r: Result) => (r.status === "premium" ? "Premium, not sold here" : r.status === "reserved" ? "Reserved by the registry" : r.status === "unknown" ? "Couldn't check right now" : "Taken now");

interface Ideas { found: Result[]; taken: string[]; more: string[]; checked: number; total: number; note: string; busy: boolean }

export function useNarrow() {
  const [narrow, setNarrow] = useState(() => matchMedia("(max-width: 720px)").matches);
  useEffect(() => { const m = matchMedia("(max-width: 720px)"); const f = () => setNarrow(m.matches); m.addEventListener("change", f); return () => m.removeEventListener("change", f); }, []);
  return narrow;
}
export function Find({ simple = false }: { simple?: boolean }) {
  const { query, results, checking, dealOpen, apiReady, apiReachable, hatchPhase, set } = useUi();
  const preview = isDemo(apiReady);
  const token = useRef(0);
  const [error, setError] = useState("");
  const [mode, setMode] = useState<"name" | "idea">("name");
  const [idea, setIdea] = useState("");
  const [ideas, setIdeas] = useState<Ideas | null>(null);
  const ideaToken = useRef(0);
  const [suggestions, setSuggestions] = useState<Result[]>([]);
  const [suggesting, setSuggesting] = useState(false);
  const [suggestionNote, setSuggestionNote] = useState("");
  const suggestionToken = useRef(0);
  // The shortlist (docs/AUDIT-2026-10-07.md D3): names only, in this tab only; prices and availability are always checked again.
  const [shortlist, setShortlist] = useState<string[]>(() => loadShortlist());
  const [shortlistNote, setShortlistNote] = useState("");
  useEffect(() => { saveShortlist(shortlist); }, [shortlist]);
  const com = staticPrices().find(p => p.tld === "com");
  useEffect(() => { if (handle.world) handle.world.overlayMode = "list"; }, [simple]);
  // One visit per page load, counted once the site knows whether this visitor gets the preview or the live shop (V4: an invite build used
  // to count a live visitor twice, first as a preview). The check runs after the parent's effects have applied the answer.
  const visited = useRef(false);
  useEffect(() => {
    if (visited.current || (apiReachable === null && import.meta.env.VITE_API_ENABLED === "1")) return;
    visited.current = true;
    const t = window.setTimeout(() => trackConversion("visit", isDemo(useUi.getState().apiReady)), 0);
    return () => window.clearTimeout(t);
  }, [apiReachable]);
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
  const lookupName = async (label: string, onlyCom: boolean) => (apiReady ? searchLive(label, onlyCom) : search(onlyCom ? `${label}.com` : label));
  /** Names from the brief, made on this page, each checked with the registry in every extension we sell (D1). */
  const findIdeas = async () => {
    const mine = ++ideaToken.current;
    // The word lists load only when someone asks for ideas, so the first page load stays small.
    let labels: string[];
    try { labels = (await import("../lib/names")).ideasFor(idea, 10).map((i) => i.label); }
    catch { if (mine === ideaToken.current) setIdeas({ found: [], taken: [], more: [], checked: 0, total: 0, busy: false, note: "Ideas couldn't load. Check your connection and try again." }); return; }
    if (mine !== ideaToken.current) return;
    const more = labels.slice(IDEA_CHECKS), total = Math.min(IDEA_CHECKS, labels.length);
    if (!labels.length) { setIdeas({ found: [], taken: [], more: [], checked: 0, total, busy: false, note: "Add a few words about what it is, who it's for or where, like \"a ceramics studio by the coast\"." }); return; }
    trackConversion("search", preview);
    const found: Result[] = [], taken: string[] = [];
    let unknown = false, checked = 0;
    setIdeas({ found: [], taken: [], more, checked, total, busy: true, note: "" });
    for (const label of labels.slice(0, IDEA_CHECKS)) {
      try {
        const all = (await lookupName(label, false))?.results ?? [];
        if (mine !== ideaToken.current) return;
        const best = bestOf(all.filter((x) => x.available), idea);
        if (best) found.push(best); else if (all.some((x) => x.status === "unknown")) unknown = true; else taken.push(label);
      } catch { if (mine !== ideaToken.current) return; unknown = true; break; }
      setIdeas({ found: [...found], taken: [...taken], more, checked: ++checked, total, busy: true, note: "" });
    }
    if (mine !== ideaToken.current) return;
    if (found.length) { trackConversion("available", preview); handle.world?.setResults(found.map((r) => ({ domain: r.domain, available: true }))); }
    setIdeas({ found, taken, more, checked, total, busy: false,
      note: found.length ? `Each name was checked just now${unknown ? " (a few checks didn't answer)" : ""}. Availability can change before checkout.`
        : unknown ? "We couldn't check these names right now. Please try again shortly." : "Those are all taken. Try different words, or check one of the ideas below." });
  };
  /** Close .com variations of a taken name (D2), each checked; the brief, when there is one, flavours them. */
  const suggest = async () => {
    const mine = ++suggestionToken.current;
    setSuggesting(true); setSuggestionNote(""); setSuggestions([]);
    const found: Result[] = []; let unknown = false;
    let labels: string[] = [];
    try { labels = (await import("../lib/names")).similarNames(query, idea).slice(0, SIMILAR_CHECKS); } catch { unknown = true; }
    for (const label of labels) {
      if (mine !== suggestionToken.current) return;
      try {
        const r = await lookupName(label, true);
        const result = r?.results.find(x => x.tld === "com");
        if (result?.available) { found.push(result); if (mine === suggestionToken.current) setSuggestions([...found]); }
        if (!result || result.status === "unknown") unknown = true;
      } catch { unknown = true; break; }
    }
    if (mine !== suggestionToken.current) return;
    setSuggestions(found); setSuggesting(false);
    setSuggestionNote(found.length ? "Each suggestion was checked. Availability can change before checkout." : unknown ? "Some checks are unavailable. Try again shortly or search another name." : "Those variations are taken too. Try describing your idea for a fresh direction.");
  };
  const keep = (domain: string) => {
    const { list, full } = toggleShortlist(shortlist, domain);
    setShortlistNote(full ? `Your shortlist holds ${SHORTLIST_MAX} names. Remove one to add another.` : "");
    if (!full) setShortlist(list);
  };
  const known = useMemo(() => {
    const m = new Map<string, Result>();
    for (const r of [...(ideas?.found ?? []), ...suggestions, ...results]) m.set(r.domain, r);
    return m;
  }, [ideas, suggestions, results]);
  const cell = (r: Result) => r.available ? (
    <div className="result-cell" key={r.domain}>
      <Chip r={r} list row={0} onPick={pick} />
      <button type="button" className="keep-btn" aria-pressed={shortlist.includes(r.domain)} aria-label={`Shortlist ${r.domain}`} onClick={() => keep(r.domain)}>
        <span aria-hidden="true">{shortlist.includes(r.domain) ? "★ " : "☆ "}</span>{shortlist.includes(r.domain) ? "On your shortlist" : "Shortlist"}
      </button>
    </div>
  ) : <Chip key={r.domain} r={r} list row={0} onPick={pick} />;
  const parsed = parseQuery(query);
  const rescuable = results.find(r => r.status === "registered");
  const takenCom = results.find(r => r.tld === "com" && !r.available && r.status !== "unknown");
  const freeElsewhere = results.filter(r => r.available);
  const stepping = hatchPhase === "hatching" || hatchPhase === "card";
  return (
    <main className={`find shop-find${results.length || ideas?.found.length ? " has-results" : ""}${simple ? " simple-find" : ""}${stepping ? " stepping-aside" : ""}`}>
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
      {mode === "idea" && <>
        <form className="idea-form" onSubmit={e => { e.preventDefault(); void findIdeas(); }}>
          <label htmlFor="idea-input">What are you bringing to life?</label>
          <textarea id="idea-input" className="text-input" value={idea} maxLength={240} placeholder="A ceramics studio inspired by the coast" onChange={e => setIdea(e.target.value)} />
          <button className="btn secondary" type="submit" disabled={!idea.trim() || !!ideas?.busy}>{ideas?.busy ? "Checking names…" : "Find names"}</button>
          <p className="fineprint">Names are made from your words on this page; your description is never sent. Only the names are checked with the registry.</p>
        </form>
        {ideas && <section className="idea-results" aria-label="Name ideas" aria-busy={ideas.busy}>
          {ideas.found.length > 0 && <div className="shop-results">{ideas.found.map(cell)}</div>}
          <p role="status" className="fineprint">{ideas.busy ? `Checking names: ${ideas.checked} of ${ideas.total}…` : ideas.note}</p>
          {!ideas.busy && ideas.taken.length > 0 && <p className="fineprint">Taken in every extension we sell: {ideas.taken.join(", ")}.</p>}
          {!ideas.busy && ideas.more.length > 0 && <div className="idea-names"><span className="fineprint">More ideas to check:</span>{ideas.more.map(l => <button type="button" className="link-btn" key={l} onClick={() => { set({ query: l }); setMode("name"); }}>{l}</button>)}</div>}
        </section>}
      </>}
      <form className="pool-input shop-search" role="search" onSubmit={e => { e.preventDefault(); void run(query); }}>
        <label htmlFor="name-input">What will you name it?</label>
        <div className="field">
          <input id="name-input" type="text" value={query} autoComplete="off" autoCapitalize="none" spellCheck={false} inputMode="url" maxLength={70} placeholder="Your next great name" onChange={e => { set({ query: e.target.value, demo: "done" }); handle.world?.keystroke(); sound.drop(); }} />
          <button type="submit" className="btn primary" disabled={checking || !query.trim()}>Search</button>
        </div>
        <p className="search-status" role="status">{checking ? "Checking availability…" : results.length ? `${results.filter(r => r.available).length} ${preview ? "potential matches" : "available names"} found` : preview && com ? `.com published test price ${com.price} / year. Public launch pricing may change.` : "Start with a name or a domain, like moonfern.com"}</p>
      </form>
      {parsed?.unsupported && results.length > 0 && <p className="notice" role="note">Mosshatch doesn't sell .{parsed.unsupported} names. Here is {parsed.label} in the extensions we do sell.</p>}
      {error && <div className="search-error" role="alert"><p>{error}</p><button className="link-btn" type="button" disabled={checking} onClick={() => void run(query)}>Try again</button></div>}
      {results.length > 0 && <div className="shop-results" aria-label="Results" aria-busy={checking}>{results.map(cell)}</div>}
      {takenCom && <section className="shop-alternatives" aria-label="Alternative .com names">
        <p><strong>The .com isn't available.</strong> {freeElsewhere.length ? `${parsed?.label ?? "This name"} ${preview ? "looks unregistered" : "is free"} as ${freeElsewhere.map(r => `.${r.tld}`).join(", ")} above, or try` : "Try"} a close .com variation.</p>
        <button className="btn secondary" type="button" disabled={suggesting} onClick={() => void suggest()}>{suggesting ? "Checking alternatives…" : "Find similar .com names"}</button>
        <div className="shop-results">{suggestions.map(cell)}</div>
        {suggestionNote && <p role="status" className="fineprint">{suggestionNote}</p>}
        <p className="fineprint">A close variation can still clash with someone's trademark or brand, and we can't check that for you. Search a trademark register before you build on a name.</p>
      </section>}
      {shortlist.length > 0 && <section className="shortlist" aria-labelledby="shortlist-h">
        <h2 id="shortlist-h">Your shortlist <span className="fineprint">{shortlist.length} of {SHORTLIST_MAX} · kept in this tab until you close it</span></h2>
        <ul>{shortlist.map(d => {
          const r = known.get(d);
          return <li key={d}>
            <span className="sl-name">{d}</span>
            <span className="sl-price">{r?.available && r.price ? <>{r.price}{per(r)}<small> · renews {r.renewal ?? r.price}{per(r)}</small></> : r ? notBuyable(r) : "Check for today's price"}</span>
            {r?.available
              ? <button type="button" className="link-btn" aria-label={`${preview ? "Preview" : "Choose"} ${d}`} onClick={() => pick(r)}>{preview ? "Preview" : "Choose"}</button>
              : <button type="button" className="link-btn" aria-label={`Check ${d} now`} onClick={() => { setMode("name"); set({ query: d }); }}>Check</button>}
            <button type="button" className="text-btn" aria-label={`Remove ${d} from your shortlist`} onClick={() => { setShortlistNote(""); setShortlist(shortlist.filter(x => x !== d)); }}>Remove</button>
          </li>;
        })}</ul>
        <p className="fineprint">Prices and availability are checked again before you pay.</p>
      </section>}
      {shortlistNote && <p role="status" className="fineprint">{shortlistNote}</p>}
      {apiReady && rescuable && <div className="rescue-offer" role="group" aria-label="Bring a name you own"><span>Already own {rescuable.domain}?</span><button type="button" className="link-btn" onClick={() => set({ rescue: { fqdn: rescuable.domain, transferId: null } })}>Transfer {rescuable.domain} here</button></div>}
      <div className="shop-links"><button type="button" className="text-btn" aria-expanded={dealOpen} onClick={() => set({ dealOpen: !dealOpen })}>The deal</button><a href="/how-it-works">How it works</a><a href="/fees.html">Prices & renewals</a><a href="/assistants">Use with Claude</a></div>
      {dealOpen && <section className="shop-deal" aria-label="The deal"><h2>A clear price. A name that's yours.</h2><p>See the registration term and renewal price before checkout. Taxes, if applicable, are shown by Stripe before you confirm.</p><p>Privacy protection is included where the registry supports it. .ai registrant details are public. No add-ons are preselected.</p><p>{preview ? "These are published invite-only test prices. A practice hatch never registers or reserves a domain." : "Availability is checked again before purchase. Your creature hatches after registration is confirmed."}</p><button className="link-btn" type="button" onClick={() => set({ dealOpen: false })}>Got it</button></section>}
      <p className="search-note">We don't sell your searches. <a href="/commitments.html">Our commitments</a> · <a href="/legal/index.html">Legal</a> · <a href="/report.html">Report abuse</a></p>
    </main>
  );
}
