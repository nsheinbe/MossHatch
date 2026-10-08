import { useEffect, useState } from "react";
import { useUi } from "../store";
import { loadWaiting, sayWaiting, type Waiting } from "../lib/waiting";

/** Read the waiting list on sign-in, when the page comes back into view, every two minutes while it is in view, and after a decision. */
export function useWaiting(): void {
  const account = useUi((s) => s.account);
  const rev = useUi((s) => s.waitingRev);
  const set = useUi((s) => s.set);
  useEffect(() => {
    if (!account) { set({ waiting: [] }); return; }
    let dead = false;
    const read = () => { if (!document.hidden) void loadWaiting().then((w) => { if (!dead) set({ waiting: w }); }).catch(() => undefined); };
    read();
    const timer = window.setInterval(read, 120_000);
    const onVis = () => { if (!document.hidden) read(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => { dead = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVis); window.removeEventListener("focus", onVis); };
  }, [account, rev, set]);
}

/** Open what waits: a token's request opens its card in Connected apps; a recipe plan opens the name's Connect tab. */
export function openWaiting(w: Waiting): void {
  const st = useUi.getState();
  if (w.source === "recipe" && w.domainId && w.fqdn) st.set({ domainPanel: { id: w.domainId, fqdn: w.fqdn }, domainTab: "connect", accountOpen: false, visitorsOpen: false });
  else st.set({ visitorsOpen: true, visitorsCard: w.id, accountOpen: false });
}

/**
 * The page's notice of what waits, at the bottom, outside the grove (the grove's own bar says it there). "Later" hides it until
 * something new arrives. The Account button keeps the count either way.
 */
export function WaitingNotice() {
  const { waiting, view, visitorsOpen, accountOpen, hatchPhase, account, domainPanel, rescue, dealOpen } = useUi();
  const [hidden, setHidden] = useState<string>("");
  const key = waiting.map((w) => w.id).join(",");
  // Never over an open panel or checkout: it would cover their buttons. The Account button keeps the count meanwhile.
  if (!account || waiting.length === 0 || view === "grove" || visitorsOpen || accountOpen || domainPanel || rescue || dealOpen || hatchPhase !== "none" || hidden === key) return null;
  const first = waiting[0]!;
  return (
    <div className="panel waiting-notice" role="status">
      <span>{waiting.length === 1 ? sayWaiting(first) : `${waiting.length} requests are waiting for your decision. The newest: ${sayWaiting(first)}`}</span>
      <span className="row-actions">
        <button type="button" className="btn primary small" onClick={() => openWaiting(first)}>Review</button>
        <button type="button" className="btn secondary small" onClick={() => setHidden(key)}>Later</button>
      </span>
    </div>
  );
}

/** The count on the Account button, described for screen readers without changing the button's name. */
export function WaitingCount() {
  const n = useUi((s) => s.waiting.length);
  if (!n) return null;
  return <span className="count-badge" aria-hidden="true">{n}</span>;
}
export function WaitingDescription() {
  const n = useUi((s) => s.waiting.length);
  return <span id="waiting-desc" className="sr-only">{n ? `${n} ${n === 1 ? "request is" : "requests are"} waiting for your decision.` : ""}</span>;
}

export type { Waiting };
