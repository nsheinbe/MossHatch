import { useEffect } from "react";
import { deriveCreatureState, type CreatureState, type DomainFacts } from "@mosshatch/core";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { useAnchor } from "./Chips";

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

function Tag({ domain, state, list }: { domain: string; state: CreatureState; list: boolean }) {
  const ref = useAnchor(domain, list);
  return (
    <span ref={ref as React.RefObject<HTMLSpanElement>} className="tag">
      <span className="dot" aria-hidden="true" style={{ background: STATE_COLOR[state] }} />
      {domain}<span className="sr-only">, {STATE_WORD[state]}</span>
    </span>
  );
}

export function Grove() {
  const { groveNames, set } = useUi();
  const sample = groveNames.length === 0 || useUi.getState().groveNames.includes("__sample__");
  void sample;
  const w = handle.world;
  const mine = w?.groveCreatures() ?? [];
  const names = mine.map((c) => ({ domain: c.traits.domain, state: c.state }));

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
    <>
      {names.map((n) => <Tag key={n.domain} domain={n.domain} state={n.state} list={false} />)}
      {names.length === 0 ? (
        <div className="panel grove-empty" role="region" aria-label="Empty grove">
          <div className="body">
            <h2>Your grove is quiet.</h2>
            <p>Hatch a name and it will walk in here.</p>
            <div className="row-actions" style={{ justifyContent: "center" }}>
              <button className="btn primary" type="button" onClick={() => set({ view: "find" })}>Find a name</button>
              <button className="btn secondary" type="button" onClick={loadSample}>Preview a sample grove</button>
            </div>
          </div>
        </div>
      ) : (
        <div className="panel grove-bar" role="status">
          <span>{parts.join(", ")}.</span>
          {groveNames.length > 0 && names.some((n) => SAMPLES.some((s) => s.domain === n.domain)) && <span className="notice"><span className="sample-tag">Sample grove.</span> These are not your domains.</span>}
        </div>
      )}
    </>
  );
}
