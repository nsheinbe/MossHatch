import { assertConfigMode, ModeError } from "../config/modeguard.ts";
import { screenSanctions, screeningBlocks, checkNewAccountLimits, LocalFixtureSanctions, type SanctionsPort } from "../compliance/index.ts";
import { buildQuote } from "../pricing/index.ts";
import { opportunisticTick } from "../jobs/engine.ts";
import type { AppContext } from "../ports.ts";
import type { StripePort } from "../stripe/port.ts";
import type { RegistrarPort } from "@mosshatch/registrar/port";
import { loadRegistrant } from "./registrant.ts";
import type { OrderCompliance, OrderPricing, OrdersServices } from "./types.ts";

/** The default pricing source: the pricing module's `buildQuote`, with the registrar price guard (D-031) switched on. */
export const defaultPricing = (registrar: RegistrarPort): OrderPricing => ({
  quote: (_ctx, c, input, now) => buildQuote(c, { fqdn: input.fqdn, years: input.years, kind: "register" }, now, { registrar }),
});

/** Velocity and new-account limits, then sanctions screening of the registrant. Any refusal is a plain 403/429 code. */
export const defaultCompliance = (sanctions: SanctionsPort): OrderCompliance => ({
  async check(ctx, c, i) {
    const v = await checkNewAccountLimits(c, i.userId, { wholesaleMinor: i.wholesaleMinor }, ctx.clock.now());
    if (!v.allowed) return { ok: false, status: v.reasons.includes("global_daily_cap") ? 503 : 429, code: v.reasons[0]! };
    const reg = await loadRegistrant(ctx, i.userId);
    const s = await screenSanctions(sanctions, c, { kind: "registrant", ref: i.userId, name: reg?.name, country: reg?.country }, ctx.clock.now());
    if (screeningBlocks(s.result)) return { ok: false, status: 403, code: "screening_hold" };
    return { ok: true };
  },
});

export interface InstallOptions {
  stripe: StripePort;
  registrar: RegistrarPort;
  registrarId?: string;
  webhookSecrets?: () => string[];
  sanctions?: SanctionsPort;
  waitUntil?: (p: Promise<unknown>) => void;
  tick?: OrdersServices["tick"];
  deleteDomain?: OrdersServices["deleteDomain"];
  pricing?: OrderPricing;
  compliance?: OrderCompliance;
}

/**
 * Put the orders services on the context. The mode guard runs here as well as in the Stripe client constructor: a Stripe
 * client whose mode disagrees with the process (a live client in a test process, or the reverse) is refused.
 */
export function installOrders(ctx: AppContext, o: InstallOptions): OrdersServices {
  // Boot guard: a process whose Stripe key, registrar mode and environment disagree does not take orders at all.
  assertConfigMode(ctx.config);
  if (o.stripe.livemode !== ctx.config.livemode) throw new ModeError(["live_key_with_non_live_registrar"]);
  if (o.registrar.capabilities().mode !== ctx.config.registrarMode) throw new ModeError(["live_key_with_non_live_registrar"]);
  const svc: OrdersServices = {
    stripe: o.stripe, registrar: o.registrar, registrarId: o.registrarId ?? "opensrs",
    pricing: o.pricing ?? defaultPricing(o.registrar),
    compliance: o.compliance ?? defaultCompliance(o.sanctions ?? new LocalFixtureSanctions()),
    registrant: (c, userId) => loadRegistrant(c, userId),
    webhookSecrets: o.webhookSecrets ?? (() => (ctx.config.stripeWebhookSecret ? [ctx.config.stripeWebhookSecret] : [])),
    waitUntil: o.waitUntil ?? (() => undefined),
    tick: o.tick ?? ((c) => { opportunisticTick(c, svc.waitUntil); }),
    deleteDomain: o.deleteDomain,
  };
  (ctx.services as Record<string, unknown>).orders = svc;
  return svc;
}

/** Whether the process may take orders at all. Reason codes only. */
export function modeProblem(ctx: AppContext, svc: OrdersServices): string | null {
  try {
    assertConfigMode(ctx.config);
    if (svc.stripe.livemode !== ctx.config.livemode) return "stripe_mode_mismatch";
    if (svc.registrar.capabilities().mode !== ctx.config.registrarMode) return "registrar_mode_mismatch";
    return null;
  } catch (e) { return e instanceof ModeError ? e.reasons[0] ?? "mode" : "mode"; }
}
