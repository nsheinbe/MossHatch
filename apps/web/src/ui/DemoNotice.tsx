import { useUi } from "../store";
import { isDemo } from "../lib/site";
import { openWaitlist } from "../lib/waitlist";

/** Demo mode, on the hatch sheet and the hatch card: this is practice, the name is not registered, and the way to want it for real. */
export function PracticeHatchNotice({ domain }: { domain: string }) {
  const apiReady = useUi((s) => s.apiReady);
  if (!isDemo(apiReady)) return null;
  return (
    <div className="practice-note" role="note">
      <p><strong>Practice hatch — this name isn't registered.</strong> When we checked, the public registry didn't list it. We don't hold it, so anyone could register it first. Nothing is reserved or charged.</p>
      <button type="button" className="btn primary" onClick={() => openWaitlist({ name: domain })}>Want it for real? Join the waitlist</button>
    </div>
  );
}
