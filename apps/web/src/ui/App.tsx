import { useEffect, useState } from "react";
import { useUi } from "../store";
import { Header } from "./Header";
import { WorldHost } from "./WorldHost";
import { Find } from "./Find";
import { HatchSheet } from "./HatchSheet";
import { CardPanel } from "./CardPanel";
import { Grove } from "./Grove";
import { Fallback } from "./Fallback";
import { handle } from "../world/handle";
import { sound } from "../audio/synth";
import { AccountPanel } from "./AccountPanel";
import { OrderReturn } from "./OrderReturn";
import { apiAvailable } from "../lib/api";
import { whoAmI } from "../lib/account";

function hasWebGL2(): boolean {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

export function App() {
  const [gl] = useState(hasWebGL2);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const { view, flash, hatchPhase, sound: soundOn, set } = useUi();

  useEffect(() => { if (soundOn) sound.setEnabled(false); /* never start audio without a fresh gesture */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // After a hatch the camera frames the newborn; restore the Find view once the card is dismissed.
    if (ready && hatchPhase === "none") handle.world?.setView(view === "grove" ? "grove" : "find");
  }, [hatchPhase, ready, view]);

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
      {view === "find" ? <Find /> : <Grove />}
      <HatchSheet />
      <CardPanel />
      <AccountPanel />
      <OrderReturn />
      <div key={flash} className={`flash${flash ? " on" : ""}`} aria-hidden="true" />
    </>
  );
}
