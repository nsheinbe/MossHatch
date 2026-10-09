import { useEffect, useRef, useState } from "react";

/** Locks immediately (before React renders disabled) and abandons continuations when a view closes. */
export function useAccountAction(say: (message: string | null) => void, explain: (error: unknown) => string) {
  const [busy, setBusy] = useState(false);
  const locked = useRef(false);
  const version = useRef(0);
  const invalidate = () => { version.current++; };
  useEffect(() => invalidate, []);
  const run = async (work: (active: () => boolean) => Promise<void>) => {
    if (locked.current) return;
    locked.current = true;
    const started = version.current;
    const active = () => started === version.current;
    setBusy(true); say(null);
    try { await work(active); }
    catch (e) { if (active()) say(explain(e)); }
    finally { locked.current = false; setBusy(false); }
  };
  return { busy, run, invalidate };
}
