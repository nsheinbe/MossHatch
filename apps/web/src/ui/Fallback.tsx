import { useState } from "react";
import { search, staticPrices } from "../lib/find";
import type { Result } from "../store";

/** No WebGL2: an in-brand page with a working plain search and price list. Never a blank screen. */
export function Fallback() {
  const [q, setQ] = useState("");
  const [res, setRes] = useState<Result[] | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true);
    const r = await search(q);
    setRes(r ? r.results : []); setBusy(false);
  };
  return (
    <main className="static-find" tabIndex={0}>
      <h1>Every name hatches.</h1>
      <p className="lede">Type a name and see what is open.</p>
      <div id="boot-panel" className="boot-panel" role="status">
        <p className="boot-title">This browser can't light the lanterns.</p>
        <p className="boot-msg">Mosshatch draws its grove with WebGL 2. The search and prices below work without it.</p>
      </div>
      <form className="static-search" role="search" onSubmit={go}>
        <label htmlFor="fb-name">What will you name it?</label>
        <input id="fb-name" type="text" value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="moonfern" />
        <button className="btn primary" type="submit" disabled={busy} style={{ justifySelf: "start", marginTop: 8 }}>Search</button>
      </form>
      {res && (
        <ul className="static-prices" aria-label="Results">
          {res.length === 0 ? <li>Type letters, numbers or hyphens.</li> : res.map((r) => (
            <li key={r.domain}><span className="ext" style={r.available ? undefined : { textDecoration: "line-through", color: "var(--st-sleeping)" }}>{r.domain}</span>
              {r.available ? <><span className="price">{r.price}</span><span className="note">{r.years === 2 ? "for 2 years, " : "first year, "}renews the same, <span className="sample-tag">sample price, simulated availability</span></span></> : <span className="note">Taken <span className="sample-tag">(simulated)</span></span>}</li>
          ))}
        </ul>
      )}
      <h2 className="prices-title">Sample prices</h2>
      <ul className="static-prices">
        {staticPrices().map((p) => <li key={p.tld}><span className="ext">.{p.tld}</span><span className="price">{p.price}</span><span className="note">{p.years === 2 ? "for 2 years" : "first year"}, renews the same</span></li>)}
      </ul>
      <p className="fineprint">These are sample prices, and availability is simulated. Nothing is for sale in this preview, and nothing you search is registered or reserved.</p>
    </main>
  );
}
