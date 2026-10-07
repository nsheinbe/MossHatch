import { useEffect, useRef } from "react";
import { handle } from "../world/handle";
import { useUi, type Result } from "../store";
import { isDemo } from "../lib/site";
export function useAnchor(id: string, list: boolean) {
  const ref = useRef<HTMLElement | null>(null);
  useEffect(() => { const w = handle.world, el = ref.current; if (!w || !el || list) return; w.overlay.set(id, el); return () => { w.overlay.delete(id); }; }, [id, list]);
  return ref;
}
export function Chip({ r, list, row, onPick }: { r: Result; list: boolean; row: number; onPick: (r: Result) => void }) {
  const ref = useAnchor(r.domain, list);
  const demo = isDemo(useUi(s => s.apiReady));
  const name = <span className="domain-name"><span className="dot" aria-hidden="true" /><span className="name">{r.domain.slice(0, r.domain.indexOf('.'))}</span><wbr /><span className="ext">.{r.tld}</span></span>;
  const style = { "--gap": row } as React.CSSProperties;
  if (!r.available) {
    // Each state says what it is (docs/AUDIT-2026-10-07.md P7): a premium name is not "couldn't check", and none of these can be bought here.
    const [kind, label, note] = r.status === 'unknown' ? ['unknown', "couldn't check right now", "Couldn't check right now"]
      : r.status === 'premium' ? ['premium', 'premium name, not sold here', 'Premium · the registry sets a higher price; not sold here']
      : r.status === 'reserved' ? ['taken', 'reserved by the registry', 'Reserved by the registry · cannot be registered']
      : ['taken', 'taken', 'Taken · already registered'];
    return <div ref={ref as React.RefObject<HTMLDivElement>} className={`chip ${kind}`} style={style} role="group" aria-label={`${r.domain}: ${label}`}>{name}<small>{note}</small></div>;
  }
  return <button ref={ref as React.RefObject<HTMLButtonElement>} type="button" className="chip" style={style} onClick={() => onPick(r)} aria-label={`${r.domain}, ${r.price ?? 'price not available'}${r.years === 2 ? ' for two years' : ' per year'}. ${demo ? 'Preview domain' : 'Buy domain'}.`}>
    {name}<span className="chip-price">{r.price ?? 'Price at launch'}<small>{r.price ? r.years === 2 ? ' / 2 years' : ' / year' : ''}</small></span>
    <small>{demo ? 'Looks unregistered · test price may change' : 'Available · before tax'}</small>
    {r.price && <small>Current renewal {r.renewal ?? r.price}{r.years === 2 ? ' / 2 years' : ' / year'}</small>}
    <span className="chip-action">{demo ? 'Preview your domain' : 'Buy domain & hatch'} <span aria-hidden="true">↗</span></span>
  </button>;
}
