import { useEffect } from "react";
import { openWaitlist } from "../../lib/waitlist";
import { handle } from "../../world/handle";

/**
 * What everyone without the launcher sees: a still scene of what talking will be like, labelled as an example, with no model call
 * and no network request. The creature glows softly once, as if about to speak.
 */
export function Teaser({ domain, name, reason, demo, onClose }: { domain: string; name: string; reason: string; demo: boolean; onClose(): void }) {
  useEffect(() => { handle.world?.goldSparks(domain); }, [domain]);
  const signedOut = reason === "unauthorized";
  return (
    <div className="lx-teaser">
      <p className="lx-kicker">Coming with launch</p>
      <h3 className="lx-title">Talk to your creature</h3>
      <p>Soon {name} will listen to what you want {domain} to be, write a brief on a scroll, and have a builder make your first website from it. You change it by telling {name} what you'd like, in your own words.</p>
      <figure className="lx-example" aria-label="Example conversation (not live)">
        <figcaption>Example, not a live conversation</figcaption>
        <p className="lx-line is-creature"><span className="lx-who">{name}</span><span className="lx-said">Hello! I'm {name}, the creature of {domain}. What would you like this place to be?</span></p>
        <p className="lx-line is-owner"><span className="lx-who">You</span><span className="lx-said">A little shop for my ceramics.</span></p>
        <p className="lx-line is-creature"><span className="lx-who">{name}</span><span className="lx-said">Oh, lovely. Who is it for, and how should it feel?</span></p>
      </figure>
      <p className="lx-fine">{signedOut ? "It opens first for invited accounts." : reason === "invite_required" ? "It opens first for invited accounts. This account doesn't have an invite yet." : "It isn't switched on yet."}</p>
      <div className="lx-actions">
        {demo && <button type="button" className="lx-btn lx-approve" onClick={() => openWaitlist({ name: domain })}>Join the waitlist</button>}
        <button type="button" className="lx-btn lx-ghost" onClick={onClose}>Back to the grove</button>
      </div>
    </div>
  );
}
