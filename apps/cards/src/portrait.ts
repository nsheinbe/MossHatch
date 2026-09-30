import { portraitSvg as svg } from "@mosshatch/core";
import type { Card } from "./data.ts";

/** Sample cards have no uploaded PNG; they get the shared flat portrait (packages/core/src/portrait.ts), coloured by the name. */
export const portraitSvg = (card: Card): string => svg(card.slug, card.family);
