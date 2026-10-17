import { hashOf } from "../util/bytes.ts";

/**
 * Pinned Domain Connect templates (DC-07 serves them, DC-09 loads the pins).
 * Production starts empty. A test or a later pin file calls `registerPinnedTemplate`.
 * The hash is SHA-256 of the canonical JSON. A body that no longer matches its pin is not served.
 */

export interface PinnedTemplate {
  providerId: string;
  serviceId: string;
  version: number;
  hash: string;
  body: unknown;
}

const pins = new Map<string, PinnedTemplate>();
const keyOf = (providerId: string, serviceId: string) => `${providerId}/${serviceId}`;

export function registerPinnedTemplate(t: PinnedTemplate): void {
  if (hashOf(t.body).toString("hex") !== t.hash) throw new Error("template hash mismatch");
  pins.set(keyOf(t.providerId, t.serviceId), t);
}

/** The template body when the pin still matches, otherwise nothing. */
export function pinnedTemplate(providerId: string, serviceId: string): unknown | null {
  const t = pins.get(keyOf(providerId, serviceId));
  if (!t || hashOf(t.body).toString("hex") !== t.hash) return null;
  return t.body;
}

/** Test hook. */
export function clearPinnedTemplates(): void { pins.clear(); }
