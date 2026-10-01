import { lazy, Suspense, useEffect, useState } from "react";
import { useUi } from "../store";
import { isDemo } from "../lib/site";
import { onOpenWaitlist, openWaitlist, type WaitlistOpen } from "../lib/waitlist";

// The form is a lazy chunk: nothing of it is in the first load.
const WaitlistForm = lazy(() => import("./WaitlistForm"));

/** The preview banner, as React renders it when the page has no static one (a live build that found no API behind it). */
export function DemoBanner() {
  return (
    <aside id="demo-banner" className="demo-banner" aria-label="Preview notice">
      <p><strong>Mosshatch isn't open yet.</strong> This is a preview — nothing you hatch is registered or charged.</p>
      <a className="demo-banner-cta" href="/waitlist" data-waitlist="banner">Join the waitlist</a>
    </aside>
  );
}

/**
 * Opens the waitlist dialog for the banner's link (the link goes to the no-JS page /waitlist when scripts do not run), the hatch
 * card and the sign-up screen, and keeps the layout clear of the banner (`--bh` is its height).
 */
export function WaitlistHost({ source }: { source: "app" | "fallback" }) {
  const apiReady = useUi((s) => s.apiReady);
  const [open, setOpen] = useState<WaitlistOpen | null>(null);
  const [staticBanner] = useState(() => !!document.getElementById("demo-banner"));
  const demo = isDemo(apiReady);
  useEffect(() => onOpenWaitlist((o) => setOpen({ source, ...o })), [source]);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[data-waitlist]");
      if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      openWaitlist({ source });
    };
    document.addEventListener("click", h);
    return () => document.removeEventListener("click", h);
  }, [source]);
  useEffect(() => {
    const root = document.documentElement;
    if (demo) root.setAttribute("data-site", "demo");
    const b = document.getElementById("demo-banner");
    if (!b || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => root.style.setProperty("--bh", `${b.offsetHeight}px`));
    ro.observe(b);
    return () => ro.disconnect();
  }, [demo]);
  return (
    <>
      {demo && !staticBanner && <DemoBanner />}
      {open && <Suspense fallback={null}><WaitlistForm {...open} onClose={() => setOpen(null)} /></Suspense>}
    </>
  );
}
