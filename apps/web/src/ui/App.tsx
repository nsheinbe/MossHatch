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

const DomainPanel = lazy(() => import("./DomainPanel"));
const Ledger = lazy(() => import("./Ledger"));
// The CLI device-approval page (/device). The code is typed by the person; the URL is never read for it.
const DeviceApprove = lazy(() => import("./DeviceApprove"));
// Visitors (tokens, connected apps, approvals) and the OAuth consent screen for MCP connectors: lazy chunks.
const Visitors = lazy(() => import("./Visitors"));
const OAuthConsent = lazy(() => import("./OAuthConsent"));
// Rescue (transfer in), opened from Find or from the Checkout return of a transfer. Lazy: nothing of it is in the first load.
const Rescue = lazy(() => import("./Rescue"));

function hasWebGL2(): boolean {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

export function App() {
  const [gl] = useState(hasWebGL2);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [device, setDevice] = useState(() => location.pathname === "/device");
  const [oauthRequest, setOauthRequest] = useState(() => { const v = new URLSearchParams(location.search).get("oauth_request"); return v && /^[0-9a-f-]{36}$/i.test(v) ? v : null; });
  const { view, flash, hatchPhase, sound: soundOn, account, domainPanel, visitorsOpen, set } = useUi();
  const rescue = useUi((s) => s.rescue);

  useEffect(() => { if (soundOn) sound.setEnabled(false); /* never start audio without a fresh gesture */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // After a hatch the camera frames the newborn; restore the Find view once the card is dismissed.
    if (ready && hatchPhase === "none") handle.world?.setView(view === "grove" || view === "ledger" ? "grove" : "find");
  }, [hatchPhase, ready, view]);

  // Signing out (or losing the session) takes the account's domains out of the scene and closes their panel.
  useEffect(() => { if (!account) { dropRealGrove(); set({ domainPanel: null, view: useUi.getState().view === "ledger" ? "find" : useUi.getState().view }); } }, [account, set]);

  useEffect(() => {
    // Is there a backend behind this deployment? A preview without a database answers 503 and stays a practice place.
    void (async () => {
      const ready = await apiAvailable();
      set({ apiReady: ready });
      if (ready) { try { set({ account: await whoAmI() }); } catch { /* signed out */ } }
      const q = new URLSearchParams(location.search);
      const id = q.get("order"), sid = q.get("session_id");
      if (location.pathname === "/checkout/return" && id && /^[0-9a-f-]{36}$/i.test(id) && sid && /^[A-Za-z0-9_]{6,200}$/.test(sid)) set({ orderId: id, orderSession: sid });
    })();
  }, [set]);

  if (!gl || failed) return <Fallback />;
  return (
    <>
      <WorldHost onReady={() => setReady(true)} onFail={() => setFailed(true)} />
      <Header />
      {view === "find" ? <Find /> : view === "grove" ? <Grove /> : <Suspense fallback={null}><Ledger /></Suspense>}
      {domainPanel && <Suspense fallback={null}><DomainPanel /></Suspense>}
      {rescue && <Suspense fallback={null}><Rescue /></Suspense>}
      {device && <Suspense fallback={null}><DeviceApprove onClose={() => { history.replaceState(null, "", "/"); setDevice(false); }} /></Suspense>}
      {visitorsOpen && account && <Suspense fallback={null}><Visitors /></Suspense>}
      {oauthRequest && <Suspense fallback={null}><OAuthConsent id={oauthRequest} onClose={() => { history.replaceState(null, "", "/"); setOauthRequest(null); }} /></Suspense>}
      <HatchSheet />
      <CardPanel />
      <AccountPanel />
      <OrderReturn />
      <div key={flash} className={`flash${flash ? " on" : ""}`} aria-hidden="true" />
    </>
  );
}
