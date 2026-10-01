import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../store";
import { explainDomain, getDomain, getSecurity, getTransfer, type DomainDetail, type Security, type TransferState } from "../lib/domains";
import { DomainOverview } from "./DomainOverview";
import { DnsTab } from "./DnsTab";
import { CardSection } from "./CardSection";

// The Nest (secrets) and the Gate (transfer away) load only when their tab opens.
const NestTab = lazy(() => import("./NestTab"));
const GateTab = lazy(() => import("./GateTab"));

type Tab = "overview" | "dns" | "nest" | "gate";

/** One domain: Overview, DNS, Nest and Gate tabs. Lazy chunk; nothing here is kept in the store except which domain is open. */
export default function DomainPanel() {
  const { domainPanel, set } = useUi();
  const [tab, setTab] = useState<Tab>("overview");
  const [d, setD] = useState<DomainDetail | null>(null);
  const [sec, setSec] = useState<Security | null>(null);
  const [xfer, setXfer] = useState<TransferState | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const head = useRef<HTMLHeadingElement>(null);
  const id = domainPanel?.id, fqdn = domainPanel?.fqdn;

  const reload = useCallback(() => {
    if (!id || !fqdn) return;
    void (async () => {
      try { setD(await getDomain(id)); setErr(null); } catch (e) { setErr(explainDomain(e)); return; }
      const [s, t] = await Promise.allSettled([getSecurity(fqdn), getTransfer(fqdn)]);
      setSec(s.status === "fulfilled" ? s.value : null);
      setXfer(t.status === "fulfilled" ? t.value : null);
      set({ groveRev: useUi.getState().groveRev + 1 });
    })();
  }, [id, fqdn, set]);
  useEffect(() => { setD(null); setSec(null); setXfer(null); setTab("overview"); reload(); }, [reload]);
  useEffect(() => { if (id) head.current?.focus(); }, [id]);
  useEffect(() => {
    if (!id) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") set({ domainPanel: null }); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [id, set]);
  if (!domainPanel) return null;

  const tabs: [Tab, string][] = [["overview", "Overview"], ["dns", "DNS"], ...(d?.released ? [] : [["nest", "Nest"] as [Tab, string]]), ["gate", "Gate"]];
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = Math.max(0, tabs.findIndex(([k]) => k === tab));
    const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length]![0];
    setTab(next);
    requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus());
  };

  return (
    <aside className="panel side wide" role="region" aria-label={`Details for ${domainPanel.fqdn}`}>
      <div className="head"><h2 ref={head} tabIndex={-1}>{domainPanel.fqdn}</h2></div>
      <div className="body">
        <div role="tablist" aria-label="Domain sections" className="tabs" onKeyDown={onKey}>
          {tabs.map(([k, label]) => (
            <button key={k} id={`tab-${k}`} type="button" role="tab" aria-selected={tab === k} aria-controls={`tabpanel-${k}`} tabIndex={tab === k ? 0 : -1} onClick={() => setTab(k)}>{label}</button>
          ))}
        </div>
        <div id={`tabpanel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
          {err && <p role="alert" className="notice">{err}</p>}
          {!d && !err && <p role="status">Loading.</p>}
          {d && tab === "overview" && <DomainOverview d={d} sec={sec} xfer={xfer} reload={reload} />}
          {d && tab === "overview" && !d.released && <CardSection domainId={d.id} fqdn={domainPanel.fqdn} />}
          {d && tab === "dns" && <DnsTab d={d} sec={sec} reloadAll={reload} />}
          {d && tab === "nest" && !d.released && <Suspense fallback={<p role="status">Loading.</p>}><NestTab key={d.id} fqdn={d.fqdn} /></Suspense>}
          {d && tab === "gate" && <Suspense fallback={<p role="status">Loading.</p>}><GateTab key={d.id} d={d} reloadAll={reload} /></Suspense>}
        </div>
        <div className="row-actions"><button type="button" className="btn secondary" onClick={() => set({ domainPanel: null })}>Close</button></div>
      </div>
    </aside>
  );
}
