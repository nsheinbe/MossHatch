import { useEffect, useState } from "react";
import { deriveCreatureState, type CreatureState, type DomainFacts } from "@mosshatch/core";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { useAnchor } from "./Chips";
import { eggFacts, stateOf, type DomainSummary } from "../lib/groveState";
import { openWaiting } from "./Waiting";

const STATE_COLOR: Record<CreatureState, string> = {
  thriving: "var(--st-healthy)", drowsy: "var(--st-drowsy)", sleeping: "var(--st-sleeping)", shedding: "var(--st-shedding)",
  attention: "var(--st-attention)", traveling: "var(--st-traveling)", armored: "var(--st-healthy)", egg: "var(--st-egg)",
};
const STATE_WORD: Record<CreatureState, string> = {
  thriving: "healthy", drowsy: "drowsy", sleeping: "sleeping", shedding: "spreading", attention: "needs you", traveling: "traveling", armored: "locked", egg: "registering",
};

/** Labelled sample data. The real grove is bound to adapter data in Phase 3. */
const SAMPLES: { domain: string; facts: DomainFacts }[] = [
  { domain: "moonfern.com", facts: { daysToExpiry: 240, transferLock: false, ageDays: 1200 } },
  { domain: "marrowbrook.io", facts: { daysToExpiry: 12, transferLock: false, ageDays: 500 } },
  { domain: "lanternwick.ai", facts: { daysToExpiry: 300, transferLock: false, ageDays: 90, attentionReason: "Verify your email to keep it" } },
  { domain: "tinkerdeep.dev", facts: { daysToExpiry: 180, transferLock: true, ageDays: 2000 } },
  { domain: "hollowmint.app", facts: { daysToExpiry: 100, transferLock: false, ageDays: 30, dnsWriteInFlight: true } },
  { domain: "stillwater.studio", facts: { daysToExpiry: -6, expiredPhase: "grace", transferLock: false, ageDays: 900 } },
];

function Tag({ domain, state, list, onOpen }: { domain: string; state: CreatureState; list: boolean; onOpen?: () => void }) {
  const ref = useAnchor(domain, list);
  const inner = (<><span className="dot" aria-hidden="true" style={{ background: STATE_COLOR[state] }} />{domain}<span className="sr-only">, {STATE_WORD[state]}{onOpen ? ". Open details" : ""}</span></>);
  return onOpen
    ? <button ref={ref as React.RefObject<HTMLButtonElement>} type="button" className="tag tag-btn" onClick={onOpen}>{inner}</button>
    : <span ref={ref as React.RefObject<HTMLSpanElement>} className="tag">{inner}</span>;
}

/** Names this session put into the world from the account's real domains, so signing out can take them out again. */
const realNames = new Set<string>();
export function dropRealGrove() { for (const n of realNames) handle.world?.removeGrove(n); realNames.clear(); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Live { key: string; fqdn: string; id?: string; state: CreatureState; age: number }

export function Grove() {
  const { groveNames, set, apiReady, account, groveRev, waiting } = useUi();
  const real = !!(apiReady && account);
  const [live, setLive] = useState<Live[]>([]);
  const [loadErr, setLoadErr] = useState(false);
  const sample = groveNames.length === 0 || useUi.getState().groveNames.includes("__sample__");
  void sample;
  const w = handle.world;
  const mine = w?.groveCreatures() ?? [];
  // A name with a request or a plan waiting for the owner shows "needs you" until it is decided (the request travels with the creature).
  const asks = new Set(waiting.map((x) => x.fqdn).filter((f): f is string => !!f));
  const names = real ? live.map((l) => ({ domain: l.fqdn, state: asks.has(l.fqdn) ? "attention" as CreatureState : l.state })) : mine.map((c) => ({ domain: c.id, state: c.state }));

  // Bound to the account's real domains when a backend is connected and someone is signed in. Otherwise this stays the Phase 1 practice grove.
  useEffect(() => {
    if (!real) return;
    let dead = false;
    void (async () => {
      try {
        const { listDomains } = await import("../lib/domains");
        const out = await listDomains();
        for (let i = 0; i < 100 && !handle.world && !dead; i++) await sleep(150);
        const wd = handle.world;
        if (dead || !wd) return;
        if (realNames.size === 0) wd.clearGrove();          // first load: drop the practice creatures
        const want: Live[] = [
          ...out.domains.map((d: DomainSummary): Live => ({ key: d.id, id: d.id, fqdn: d.fqdn, state: stateOf(d).state, age: d.age_days })),
          ...out.eggs.map((e): Live => ({ key: e.order_id, fqdn: e.fqdn, state: deriveCreatureState(eggFacts()).state, age: 0 })),
        ];
        const have = new Map(wd.groveCreatures().map((c) => [c.id, c]));
        for (const n of [...realNames]) if (!want.some((x) => x.fqdn === n)) { wd.removeGrove(n); realNames.delete(n); }
        for (const x of want) {
          const c = have.get(x.fqdn);
          if (c) c.setState(x.state); else wd.addToGrove(x.fqdn, x.state, x.age);
          realNames.add(x.fqdn);
        }
        setLive(want);
        set({ groveIndex: Object.fromEntries(out.domains.map((d: DomainSummary) => [d.fqdn, d.id])) });
        setLoadErr(false);
      } catch { if (!dead) setLoadErr(true); }
    })();
    return () => { dead = true; };
  }, [real, groveRev]);

  // The creatures follow: "needs you" while something waits for the name, back to their own state after.
  useEffect(() => {
    const wd = handle.world;
    if (!real || !wd) return;
    for (const c of wd.groveCreatures()) {
      const l = live.find((x) => x.fqdn === c.id);
      if (l) c.setState(asks.has(l.fqdn) ? "attention" : l.state);
    }
  }, [real, live, waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    handle.world?.setView("grove");
    return () => { handle.world?.setView("find"); };
  }, []);

  const loadSample = () => {
    const wd = handle.world; if (!wd) return;
    wd.clearGrove();
    for (const s of SAMPLES) {
      const d = deriveCreatureState(s.facts);
      wd.addToGrove(s.domain, d.state, s.facts.ageDays);
    }
    set({ groveNames: SAMPLES.map((s) => s.domain) });
  };

  const counts = names.reduce((a, n) => { a[n.state] = (a[n.state] ?? 0) + 1; return a; }, {} as Record<string, number>);
  const parts = [`${names.length} ${names.length === 1 ? "creature" : "creatures"}`];
  if (counts.drowsy) parts.push(`${counts.drowsy} drowsy`);
  if (counts.attention) parts.push(`${counts.attention} needs you`);
  if (counts.sleeping) parts.push(`${counts.sleeping} sleeping`);

  return (
    <main>
      {real
        ? live.map((l) => <Tag key={l.key} domain={l.fqdn} state={l.state} list={false} onOpen={l.id ? () => set({ domainPanel: { id: l.id!, fqdn: l.fqdn } }) : undefined} />)
        : names.map((n) => <Tag key={n.domain} domain={n.domain} state={n.state} list={false} />)}
      {loadErr && <div className="panel grove-bar" role="alert"><span>We could not load your domains. Try again in a moment.</span></div>}
      {names.length === 0 && !loadErr ? (
        <div className="panel grove-empty" role="region" aria-label="Empty grove">
          <div className="body">
            <h2>Your grove is quiet.</h2>
            <p>Hatch a name and it will walk in here.{apiReady && !account ? " Sign in to see the names you own." : ""}</p>
            <div className="row-actions" style={{ justifyContent: "center" }}>
              <button className="btn primary" type="button" onClick={() => set({ view: "find" })}>Find a name</button>
              {!real && <button className="btn secondary" type="button" onClick={loadSample}>Preview a sample grove</button>}
            </div>
          </div>
        </div>
      ) : (
        <div className="panel grove-bar" role="status">
          <span>{parts.join(", ")}.</span>
          {real && waiting.length > 0 && (
            <span className="row-actions" style={{ marginTop: 0 }}>
              <span>{waiting.length === 1 ? "1 request waits for you." : `${waiting.length} requests wait for you.`}</span>
              <button type="button" className="btn primary small" onClick={() => openWaiting(waiting[0]!)}>Review</button>
            </span>
          )}
          {!real && groveNames.length > 0 && names.some((n) => SAMPLES.some((s) => s.domain === n.domain)) && <span className="notice"><span className="sample-tag">Sample grove.</span> These are not your domains.</span>}
        </div>
      )}
    </main>
  );
}
