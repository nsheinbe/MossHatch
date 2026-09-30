import { ageInWords, deriveTraits, mossFromAge } from "@mosshatch/core";
import { useUi } from "../store";
import { handle } from "../world/handle";
import { sound } from "../audio/synth";

/** The hatch sequence and the card, shared by the practice hatch and a paid order. The name must already be an egg in the world. */
export async function runHatch(domain: string): Promise<void> {
  const w = handle.world;
  const set = useUi.getState().set;
  if (!w) return;
  set({ hatchPhase: "hatching" });
  try {
    const c = await w.hatch(domain);
    const traits = deriveTraits(domain);
    const image = w.snapshot(c);
    w.adopt(c);
    sound.voice(traits.family, traits.pitch);
    c.hop();
    set({
      hatchPhase: "card",
      groveNames: [...useUi.getState().groveNames, domain],
      card: {
        domain, image, species: traits.speciesName,
        traits: [`${traits.rarity} coat`, `${traits.earLength > 1.1 ? "long" : "short"} ears`, `${traits.tailLength > 1.15 ? "long" : "short"} tail`, `${traits.spots} ${traits.spots === 1 ? "spot" : "spots"}`],
        hatchedOn: new Date().toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
        moss: `${ageInWords(0)} (moss ${Math.round(mossFromAge(0) * 100)}%)`,
        address: `hatchkind.com/${domain}`,
      },
    });
  } catch { set({ hatchPhase: "sheet" }); }
}
