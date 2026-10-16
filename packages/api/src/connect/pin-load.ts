import { hashOf } from "../util/bytes.ts";
import { registerPinnedTemplate } from "./templates.ts";

/**
 * DC-09. A template is served only when its body hashes to the pin, its version is the pin's version,
 * and it does not move the zone (NS) or put a CNAME on the apex. A version change needs a new pin.
 * Production passes an inline body. A URL is pulled only when a fetch function is given, so boot never
 * calls the network.
 */

export interface PinSpec {
  providerId: string;
  serviceId: string;
  version: number;
  hash: string;
  body?: unknown;
  url?: string;
}

export function reviewTemplate(body: unknown): { ok: true } | { ok: false; reason: "shape" | "ns" | "apex_cname" } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { records?: unknown }).records)) return { ok: false, reason: "shape" };
  for (const rec of (body as { records: unknown[] }).records) {
    if (!rec || typeof rec !== "object") return { ok: false, reason: "shape" };
    const type = String((rec as { type?: unknown }).type ?? "").toUpperCase();
    const host = String((rec as { host?: unknown }).host ?? "@");
    if (type === "NS") return { ok: false, reason: "ns" };
    if (type === "CNAME" && (host === "@" || host === "")) return { ok: false, reason: "apex_cname" };
  }
  return { ok: true };
}

/** Register one pin, or refuse it. A refusal does not replace a pin that was already registered. */
export function installPin(pin: PinSpec): "loaded" | "refused" {
  const body = pin.body;
  if (!body || typeof body !== "object") return "refused";
  if ((body as { version?: unknown }).version !== pin.version) return "refused";
  if (hashOf(body).toString("hex") !== pin.hash) return "refused";
  if (!reviewTemplate(body).ok) return "refused";
  registerPinnedTemplate({ providerId: pin.providerId, serviceId: pin.serviceId, version: pin.version, hash: pin.hash, body });
  return "loaded";
}

/** Load inline pins. An entry with no body is refused and not fetched. */
export function loadPinList(pins: readonly PinSpec[]): { loaded: string[]; refused: string[] } {
  const loaded: string[] = [];
  const refused: string[] = [];
  for (const pin of pins) {
    const id = `${pin.providerId}/${pin.serviceId}`;
    if (installPin(pin) === "loaded") loaded.push(id);
    else refused.push(id);
  }
  return { loaded, refused };
}

/** Pull a template body, then run the same pin checks. `fetchImpl` is required for a URL so tests never use live DNS or HTTP. */
export async function pullPin(pin: PinSpec, fetchImpl?: (url: string) => Promise<{ ok: boolean; json: () => Promise<unknown> }>): Promise<"loaded" | "refused"> {
  if (pin.body !== undefined) return installPin(pin);
  if (!pin.url || !fetchImpl) return "refused";
  let body: unknown;
  try {
    const res = await fetchImpl(pin.url);
    if (!res.ok) return "refused";
    body = await res.json();
  } catch { return "refused"; }
  return installPin({ ...pin, body });
}
