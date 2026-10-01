import { ageInWords, mossFromAge } from "@mosshatch/core";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { sound } from "../audio/synth";

/** The hatch sequence and the card, shared by the practice hatch and a paid order. The name must already be an egg in the world. */
export async function runHatch(domain: string, opts: { practice?: boolean } = {}): Promise<void> {
  const w = handle.world;
  const set = useUi.getState().set;
  if (!w) return;
  set({ hatchPhase: "hatching" });
  try {
    const c = await w.hatch(domain);
    // Card phrases come from the creature kit (already loaded with the world), keeping them out of the first-load bundle.
    const { cardTraits, TIER_LABEL } = await import("../world/creatures/kit");
    // The card reads the creature's spec only, so a stored spec draws the same card.
    const spec = c.spec;
    const image = w.snapshot(c);
    w.adopt(c);
    sound.voice(spec.species, spec.choreography.pitch);
    c.react();
    set({
      hatchPhase: "card",
      groveNames: [...useUi.getState().groveNames, domain],
      card: {
        domain, image, species: spec.speciesName, tier: spec.tier, tierLabel: TIER_LABEL[spec.tier], bio: spec.bio,
        traits: cardTraits(spec),
        hatchedOn: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
        moss: `${ageInWords(0)} (moss ${Math.round(mossFromAge(0) * 100)}%)`,
        address: `hatchkind.com/${domain}`,
        ...(opts.practice ? { practice: true } : {}),
      },
    });
  } catch { set({ hatchPhase: "sheet" }); }
}
