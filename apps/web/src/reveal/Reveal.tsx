import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useUi } from "../store";
import type { StepUpType } from "../lib/domains";
import { StepUp, type StepUpRequest } from "../ui/StepUp";
import type { SecretValue } from "./secretValue";
import { fetchReveal, revealText } from "./fetchReveal";
import { canExtend, CLIPBOARD_CLEAR_MS, extend, HOLD_MS, startRehide, tick, valueCopyAllowed, type RehideState } from "./rehide";

export interface RevealTarget { id: string; name: string; env: string; version: number }

/**
 * Hold-to-reveal for one secret (PLAN 4.5, 4.6 rows 7 and 8, D-010). A pointer holds the button for one second; the keyboard and
 * switch path is a single activation (Enter or Space). Either way the passkey step-up follows, and one step-up reveals once.
 * The value is held in a ref-backed `SecretValue`, written into one DOM node with `textContent` (never through React props, never
 * into the store, storage, the URL or a live region), and removed when the timer ends, on "Hide now", when the tab is hidden, on
 * window blur, `pagehide`, `freeze`, `beforeunload`, and when this component goes away (tab change, domain change, panel close).
 */
export function Reveal({ s, prodCopy }: { s: RevealTarget; prodCopy: boolean }) {
  const rehideSeconds = useUi((x) => x.rehideSeconds);
  const value = useRef<SecretValue | null>(null);
  const node = useRef<HTMLElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const holdBtn = useRef<HTMLButtonElement | null>(null);
  const refocus = useRef(false);
  const holdTimer = useRef(0);
  const clipTimer = useRef(0);
  const [shown, setShown] = useState(false);
  const [clock, setClock] = useState<RehideState | null>(null);
  const [req, setReq] = useState<StepUpRequest | null>(null);
  const [holding, setHolding] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [short, setShort] = useState(false);

  /** Drop the value from the DOM and the ref. Safe during unmount (no state). */
  const wipe = useCallback(() => {
    if (node.current) node.current.textContent = "";
    value.current?.drop();
    value.current = null;
  }, []);
  const hide = useCallback((why: string) => {
    // Keyboard and screen-reader users were inside the value box; the box goes, so their place moves back to the reveal button.
    if (box.current && box.current.contains(document.activeElement)) refocus.current = true;
    wipe(); setShown(false); setClock(null); setNote(why);
  }, [wipe]);

  useEffect(() => () => { wipe(); window.clearTimeout(holdTimer.current); window.clearTimeout(clipTimer.current); }, [wipe]);
  useEffect(() => { if (!shown && refocus.current) { refocus.current = false; holdBtn.current?.focus(); } }, [shown]);

  // Write the value into its one node after it mounts; focus it so a screen reader reads it (it is not a live region).
  useLayoutEffect(() => {
    if (!shown || !node.current || !value.current || document.hidden) return;
    node.current.textContent = value.current.expose((v) => v);
    node.current.focus();
  }, [shown]);

  useEffect(() => {
    if (!shown) return;
    const gone = () => hide("Hidden because you left the page.");
    // Hidden before the listeners below exist (the tab changed as the value arrived): hide now, the event will not come again.
    if (document.hidden) { gone(); return; }
    const t = window.setInterval(() => setClock((c) => (c ? tick(c) : c)), 1000);
    const vis = () => { if (document.hidden) gone(); };
    document.addEventListener("visibilitychange", vis);
    document.addEventListener("freeze", gone);
    window.addEventListener("blur", gone);
    window.addEventListener("pagehide", gone);
    window.addEventListener("beforeunload", gone);
    return () => {
      window.clearInterval(t);
      document.removeEventListener("visibilitychange", vis);
      document.removeEventListener("freeze", gone);
      window.removeEventListener("blur", gone);
      window.removeEventListener("pagehide", gone);
      window.removeEventListener("beforeunload", gone);
    };
  }, [shown, hide]);
  useEffect(() => { if (shown && clock && clock.left === 0) hide("Hidden again. Reveal it with your passkey to see it again."); }, [shown, clock, hide]);

  const begin = () => {
    setMsg(null); setNote(null); setShort(false);
    setReq({
      type: "secret.reveal" as StepUpType, target: s.id,
      run: async (actionId) => {
        try {
          const v = await fetchReveal(s.id, actionId);
          // The page was hidden while the value was on its way: the hide events already fired, so it is never shown. One step-up, one try.
          if (document.hidden) { v.drop(); setNote("Hidden because you left the page. Reveal it with your passkey to see it."); return; }
          value.current?.drop();
          value.current = v;
          setClock(startRehide(rehideSeconds));
          setShown(true);
        } catch (e) { setMsg(revealText(e)); }
      },
    });
  };
  const startHold = () => {
    if (req || shown) return;
    setHolding(true); setMsg(null);
    window.clearTimeout(holdTimer.current);
    holdTimer.current = window.setTimeout(() => { setHolding(false); holdTimer.current = 0; begin(); }, HOLD_MS);
  };
  const endHold = () => {
    if (!holdTimer.current) return;
    window.clearTimeout(holdTimer.current); holdTimer.current = 0; setHolding(false);
    // A short press is not a hold. The single-activation path is offered at once (D-010), still behind the passkey.
    setShort(true);
  };

  const copyOk = valueCopyAllowed(s.env, prodCopy);
  const copy = async () => {
    const v = value.current;
    if (!v || !copyOk) return;
    try {
      await v.expose((x) => navigator.clipboard.writeText(x));
      const cb = navigator.clipboard as Clipboard & { addEventListener?: Clipboard["addEventListener"] };
      if (typeof cb.addEventListener === "function" && "onclipboardchange" in cb) {
        // The page never reads the clipboard. If nothing else was copied within 30 seconds, overwrite it.
        let changed = false;
        const mark = () => { changed = true; };
        cb.addEventListener("clipboardchange", mark, { once: true });
        window.clearTimeout(clipTimer.current);
        clipTimer.current = window.setTimeout(() => { cb.removeEventListener("clipboardchange", mark); if (!changed) void navigator.clipboard.writeText("").catch(() => undefined); }, CLIPBOARD_CLEAR_MS);
        setNote("Copied. We clear the clipboard in 30 seconds if you copy nothing else. Clipboard history or sync may still keep it.");
      } else setNote("Copied. Your clipboard history or sync may keep it; clear it when you are done.");
    } catch { setNote("Copying did not work in this browser."); }
  };

  const left = clock?.left ?? 0;
  return (
    <div className="reveal">
      {!shown && !req && (
        <>
          <button
            ref={holdBtn} type="button" className={`btn secondary small hold${holding ? " holding" : ""}`} aria-describedby={`hold-${s.id}`}
            onPointerDown={(e) => { if (e.button === 0) startHold(); }} onPointerUp={endHold} onPointerLeave={endHold} onPointerCancel={endHold}
            onClick={(e) => { if (e.detail === 0) begin(); }} onContextMenu={(e) => e.preventDefault()}
          >
            {holding ? "Keep holding" : "Hold to reveal"}<span className="sr-only"> {s.name}</span>
          </button>
          <span id={`hold-${s.id}`} className="sr-only">Press and hold for one second, or press Enter. Then confirm with your passkey.</span>
          {short && (
            <p className="notice">Hold the button for one second, or <button type="button" className="text-btn" onClick={begin}>reveal {s.name} without holding</button>. You confirm with your passkey either way.</p>
          )}
        </>
      )}
      {req && <StepUp key={s.id} req={req} onDone={() => setReq(null)} />}
      {shown && (
        <div ref={box} className="code-box secret-box" role="group" aria-label={`Value of ${s.name}`}>
          <p>Hides in {left} {left === 1 ? "second" : "seconds"}.</p>
          <p><code ref={node} tabIndex={-1} className="xfer-code secret-value" /></p>
          <div className="row-actions">
            <button type="button" className="btn secondary small" onClick={() => hide("Hidden.")}>Hide now</button>
            <button type="button" className="btn secondary small" disabled={!clock || !canExtend(clock)} onClick={() => setClock((c) => (c ? extend(c) : c))}>Keep showing for 30 more seconds</button>
            <button type="button" className="btn secondary small" disabled={!copyOk} onClick={() => void copy()}>Copy value</button>
          </div>
          {!copyOk && <p className="notice">Copying production values is off. Turn it on above the list if you need it.</p>}
        </div>
      )}
      {msg && <p role="status" className="notice">{msg}</p>}
      {note && !shown && <p className="notice">{note}</p>}
      {note && shown && <p role="status" className="notice">{note}</p>}
    </div>
  );
}
