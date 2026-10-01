import { lazy, Suspense, useEffect, useState } from "react";
import { useUi } from "../store";
import { Header } from "./Header";
import { WorldHost } from "./WorldHost";
import { Find } from "./Find";
import { HatchSheet } from "./HatchSheet";
import { CardPanel } from "./CardPanel";
import { Grove, dropRealGrove } from "./Grove";
import { Fallback } from "./Fallback";
import { handle } from "../world/handle";
import { sound } from "../audio/synth";
import { AccountPanel } from "./AccountPanel";
import { OrderReturn } from "./OrderReturn";
import { apiAvailable } from "../lib/api";
import { whoAmI } from "../lib/account";
import { WaitlistHost } from "./WaitlistHost";
import { takeInviteFromUrl } from "../lib/waitlist";
import { applySiteChrome, buildSiteMode, liveFor } from "../lib/site";

const DomainPanel = lazy(() => import("./DomainPanel"));
const Ledger = lazy(() => import("./Ledger"));
// The CLI device-approval page (/device). The code is typed by the person; the URL is never read for it.
const DeviceApprove = lazy(() => import("./DeviceApprove"));
// Visitors (tokens, connected apps, approvals) and the OAuth consent screen for MCP connectors: lazy chunks.
const Visitors = lazy(() => import("./Visitors"));
const OAuthConsent = lazy(() => import("./OAuthConsent"));
// Rescue (transfer in), opened from Find or from the Checkout return of a transfer. Lazy: nothing of it is in the first load.
const Rescue = lazy(() => import("./Rescue"));
// The brand launcher (talk to a creature, brief, build): its own chunk and stylesheet, loaded when a conversation opens.
const Launcher = lazy(() => import("./launcher/Launcher"));

/** App-only routes (device approval, checkout return, invite, OAuth consent) are never indexed; vercel.json also sends X-Robots-Tag. */
function noindexAppRoutes() {
  if (!["/device", "/checkout/return", "/invite"].includes(location.pathname) && !new URLSearchParams(location.search).has("oauth_request")) return;
  const m = document.createElement("meta");
  m.name = "robots"; m.content = "noindex";
  document.head.append(m);
}

function hasWebGL2(): boolean {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

export function App() {
  const [gl] = useState(hasWebGL2);
  // An invite link (/invite?t=…) opens sign-up on a live site; the token stays in memory only and the URL is cleaned at once.
  const [invited] = useState(() => { noindexAppRoutes(); return takeInviteFromUrl(); });
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [device, setDevice] = useState(() => location.pathname === "/device");
  const [oauthRequest, setOauthRequest] = useState(() => { const v = new URLSearchParams(location.search).get("oauth_request"); return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null; });
  const { view, flash, hatchPhase, sound: soundOn, account, domainPanel, visitorsOpen, apiReachable, set } = useUi();
  const rescue = useUi((s) => s.rescue);
  const talk = useUi((s) => s.talk);

  useEffect(() => { if (soundOn) sound.setEnabled(false); /* never start audio without a fresh gesture */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // After a hatch the camera frames the newborn; restore the Find view once the card is dismissed.
    // While a creature talks (the launcher), it keeps the camera.
    if (ready && hatchPhase === "none" && !talk) handle.world?.setView(view === "grove" || view === "ledger" ? "grove" : "find");
  }, [hatchPhase, ready, view, talk]);

  // Signing out (or losing the session) takes the account's domains out of the scene and closes their panel.
  useEffect(() => { if (!account) { dropRealGrove(); set({ domainPanel: null, view: useUi.getState().view === "ledger" ? "find" : useUi.getState().view }); } }, [account, set]);

  // Invite build: the live shop follows the signed-in account (signing in or out switches it), and the banner with it.
  useEffect(() => {
    if (buildSiteMode !== "invite" || apiReachable === null) return;
    const live = apiReachable === true && liveFor(account);
    set({ apiReady: live });
    applySiteChrome(live);
  }, [account, apiReachable, set]);

  useEffect(() => {
    // Is there a backend behind this deployment? A preview without a database answers 503 and stays a practice place.
    void (async () => {
      const ready = await apiAvailable();
      let me = null;
      if (ready) { try { me = await whoAmI(); } catch { /* signed out */ } }
      // Invite build: reachable is not live; only an account with live access gets the shop (the effect above).
      set({ apiReachable: ready, account: me, ...(buildSiteMode === "invite" ? {} : { apiReady: ready }) });
      if (ready && invited && buildSiteMode !== "demo") set({ accountOpen: true });
      const q = new URLSearchParams(location.search);
      const id = q.get("order"), sid = q.get("session_id");
      if (location.pathname === "/checkout/return" && id && /^[0-9a-f-]{36}$/i.test(id) && sid && /^[A-Za-z0-9_]{6,200}$/.test(sid)) set({ orderId: id, orderSession: sid });
    })();
  }, [set]);

  if (!gl || failed) return <><Fallback /><WaitlistHost source="fallback" /></>;
  return (
    <>
      <WorldHost onReady={() => setReady(true)} onFail={() => setFailed(true)} />
      <Header />
      {/* While a creature talks, the scene belongs to it: the search, chips and grove bar step aside. */}
      {talk ? null : view === "find" ? <Find /> : view === "grove" ? <Grove /> : <Suspense fallback={null}><Ledger /></Suspense>}
      {domainPanel && <Suspense fallback={null}><DomainPanel /></Suspense>}
      {rescue && <Suspense fallback={null}><Rescue /></Suspense>}
      {talk && <Suspense fallback={null}><Launcher /></Suspense>}
      {device && <Suspense fallback={null}><DeviceApprove onClose={() => { history.replaceState(null, "", "/"); setDevice(false); }} /></Suspense>}
      {visitorsOpen && account && <Suspense fallback={null}><Visitors /></Suspense>}
      {oauthRequest && <Suspense fallback={null}><OAuthConsent id={oauthRequest} onClose={() => { history.replaceState(null, "", "/"); setOauthRequest(null); }} /></Suspense>}
      <HatchSheet />
      <CardPanel />
      <AccountPanel />
      <OrderReturn />
      <WaitlistHost source="app" />
      <div key={flash} className={`flash${flash ? " on" : ""}`} aria-hidden="true" />
    </>
  );
}
