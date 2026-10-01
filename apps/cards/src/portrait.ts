import { deriveCreatureSpec, portraitSvg as svg } from "@mosshatch/core";
import type { Card } from "./data.ts";

/** Sample cards have no uploaded PNG; they get the shared flat portrait (packages/core/src/portrait.ts), drawn from the name's spec. */
export const portraitSvg = (card: Card): string => svg({ ...deriveCreatureSpec(card.slug), species: card.family });
