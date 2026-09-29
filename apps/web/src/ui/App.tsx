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

function hasWebGL2(): boolean {
  try { return !!document.createElement("canvas").getContext("webgl2"); } catch { return false; }
}

export function App() {
  const [gl] = useState(hasWebGL2);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const { view, flash, hatchPhase, sound: soundOn } = useUi();

  useEffect(() => { if (soundOn) sound.setEnabled(false); /* never start audio without a fresh gesture */ }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    // After a hatch the camera frames the newborn; restore the Find view once the card is dismissed.
    if (ready && hatchPhase === "none") handle.world?.setView(view === "grove" ? "grove" : "find");
  }, [hatchPhase, ready, view]);

  if (!gl || failed) return <Fallback />;
  return (
    <>
      <WorldHost onReady={() => setReady(true)} onFail={() => setFailed(true)} />
      <Header />
      {view === "find" ? <Find /> : <Grove />}
      <HatchSheet />
      <CardPanel />
      <div key={flash} className={`flash${flash ? " on" : ""}`} aria-hidden="true" />
    </>
  );
}
