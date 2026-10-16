import type { PinSpec } from "./pin-load.ts";

/**
 * The production allow-list. Empty on purpose: a provider lands in its own change, with a hash of
 * the template body. Do not add a service here until that body has been reviewed.
 */
export const PRODUCTION_PINS: PinSpec[] = [];
