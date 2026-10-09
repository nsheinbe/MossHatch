import { useCallback, useEffect, useRef, useState } from "react";

/** Locks immediately (before React renders disabled) and abandons continuations when a view closes. */
export function useAccountAction(say: (message: string | null) => void, explain: (error: unknown) => string) {
  const [busy, setBusy] = useState(false);
  const pending = useRef<object | null>(null);
  const version = useRef(0);
  const invalidate = useCallback(() => { version.current++; pending.current = null; setBusy(false); }, []);
  useEffect(() => () => { version.current++; pending.current = null; }, []);
  const run = async (work: (active: () => boolean) => Promise<void>) => {
    if (pending.current) return;
    const attempt = {};
    pending.current = attempt;
    const started = version.current;
    const active = () => started === version.current;
    setBusy(true); say(null);
    try { await work(active); }
    catch (e) { if (active()) say(explain(e)); }
    finally { if (pending.current === attempt) { pending.current = null; if (active()) setBusy(false); } }
  };
  return { busy, run, invalidate };
}
