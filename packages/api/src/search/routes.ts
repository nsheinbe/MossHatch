import { withNoUser, withUser } from "@mosshatch/db";
import type { RegistrarPort } from "@mosshatch/registrar/port";
import { HttpError, json } from "../http/router.ts";
import type { Router } from "../http/router.ts";
import type { HandlerReq } from "../http/types.ts";
import { hit } from "../ratelimit.ts";
import type { Limit } from "../ratelimit.ts";
import { buildQuote, PricingError, quoteToJson } from "../pricing/quote.ts";
import { normalizeLabel, parseFqdn, parseTlds } from "./labels.ts";
import { chipPrices, searchAvailability, SearchCache } from "./service.ts";
import { tldNotices } from "../closure/tld-https.ts";
import { registrarOfRecord } from "@mosshatch/core";
import { priceTableFor } from "../pricing/registrar.ts";
import { salesPaused } from "../orders/create.ts";
import { refundWindow } from "../domains/refunds.ts";

/** Rate limits (PLAN.md 4.5 table row "Search and quote"; own targets, tuned after OpenSRS answers). */
export const LIMIT_ANON_IP: Limit = { bucket: "search:ip", max: 30, windowSeconds: 600 };
export const LIMIT_ANON_NET: Limit = { bucket: "search:net", max: 100, windowSeconds: 3600 };
export const LIMIT_USER: Limit = { bucket: "search:user", max: 300, windowSeconds: 3600 };

function clientAddress(r: Request): string {
  return (r.headers.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";
}

/**
 * Anonymous callers: per address and per /24. Verified signed-in users (session or agent/CLI binding): 300 an hour per user.
 * Counter keys are HMACs (see `hit`); nothing here stores the address or the searched text.
 */
async function enforceLimits(req: HandlerReq): Promise<void> {
  const { ctx } = req;
  let userId: string | undefined;
  if ((req.principal.kind === "session" || req.principal.kind === "binding") && req.principal.userId) {
    const verified = await withUser(ctx.runtime, req.principal.userId, async (c) => (await c.query("select email_verified_at is not null as v from users where id = $1", [req.principal.userId])).rows[0]?.v === true);
    if (verified) userId = req.principal.userId;
  }
  const checks = await withNoUser(ctx.runtime, async (c) => {
    if (userId) return [await hit(ctx, c, `search:user:${userId}`, LIMIT_USER)];
    const ip = await hit(ctx, c, `search:ip:${clientAddress(req.request)}`, LIMIT_ANON_IP);
    if (!ip.allowed) return [ip];
    return [ip, await hit(ctx, c, `search:net:${req.ipPrefix}`, LIMIT_ANON_NET)];
  });
  const blocked = checks.find((x) => !x.allowed);
  if (blocked) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(blocked.retryAfterSeconds) });
}

function registrarOf(req: HandlerReq, fixed?: RegistrarPort): RegistrarPort {
  const r = fixed ?? (req.ctx.services["registrar"] as RegistrarPort | undefined);
  if (!r) throw new HttpError(503, "search_unavailable");
  return r;
}

function onlyParams(url: URL, allowed: string[]) {
  for (const k of url.searchParams.keys()) if (!allowed.includes(k)) throw new HttpError(400, "unexpected_param");
  for (const k of allowed) if (url.searchParams.getAll(k).length > 1) throw new HttpError(400, "unexpected_param");
  if (url.search.length > 4000) throw new HttpError(400, "bad_request");
}

export function registerSearchRoutes(router: Router, opts: { registrar?: RegistrarPort; cache?: SearchCache } = {}): Router {
  const cache = opts.cache ?? new SearchCache();
  router.add(
    {
      method: "GET", path: "/api/v1/search", principals: ["anonymous", "session", "binding"], tag: "search", liveGate: true,
      handler: async (req) => {
        onlyParams(req.url, ["name", "tlds"]);
        const name = normalizeLabel(req.url.searchParams.get("name") ?? "");
        if (!name.ok) throw new HttpError(400, "bad_name");
        const tlds = parseTlds(req.url.searchParams.get("tlds"));
        if (!tlds.ok) throw new HttpError(400, "bad_tlds");
        await enforceLimits(req);
        const registrar = registrarOf(req, opts.registrar);
        const { items, degraded } = await searchAvailability(req.ctx, { registrar, cache }, name.label, tlds.tlds);
        const prices = await withNoUser(req.ctx.runtime, (c) => chipPrices(c, tlds.tlds, req.ctx.clock.now()));
        return json({
          degraded,
          results: items.map((i) => {
            const p = prices.get(i.tld);
            return {
              fqdn: i.fqdn, tld: i.tld, kind: i.kind, source: i.source, unconfirmed: i.unconfirmed,
              price: p && (i.kind === "available" || i.kind === "unknown") ? { years: p.years, subtotal_minor: p.subtotalMinor.toString(), currency: "usd" } : null,
            };
          }),
        });
      },
    },
    {
      method: "GET", path: "/api/v1/quote", principals: ["anonymous", "session", "binding"], tag: "search", liveGate: true,
      handler: async (req) => {
        // The client sends only the name and the term. A price, total or any other parameter is refused, not ignored.
        onlyParams(req.url, ["domain", "years"]);
        const fq = parseFqdn(req.url.searchParams.get("domain") ?? "");
        if (!fq) throw new HttpError(400, "bad_name");
        const yearsRaw = req.url.searchParams.get("years");
        if (yearsRaw !== null && !/^\d{1,2}$/.test(yearsRaw)) throw new HttpError(400, "invalid_term");
        await enforceLimits(req);
        let quote;
        try {
          quote = await withNoUser(req.ctx.runtime, (c) => buildQuote(c, { fqdn: `${fq.label}.${fq.tld}`, years: yearsRaw === null ? undefined : Number(yearsRaw) }, req.ctx.clock.now()));
        } catch (e) {
          if (e instanceof PricingError) throw new HttpError(e.code === "no_price" ? 503 : e.code === "premium_refused" || e.code === "price_mismatch" ? 422 : 400, e.code);
          throw e;
        }
        const registrar = registrarOf(req, opts.registrar);
        const { items } = await searchAvailability(req.ctx, { registrar, cache }, fq.label, [fq.tld as never]);
        const a = items[0]!;
        const purchasable = a.kind === "available" || a.kind === "unknown";
        // The checkout sheet's disclosure rows come from here, not from client constants: whether new registrations are open right now
        // (orders or registrar writes paused refuse checkout), the registrar of record (D-024 row 12) and the refund window (row 9).
        const table = priceTableFor(fq.tld);
        const facts = await withNoUser(req.ctx.runtime, async (c) => ({ paused: await salesPaused(c), refund: await refundWindow(c, table, fq.tld) }));
        const rec = registrarOfRecord(table);
        // C-58: the HTTPS notice for .dev and .app travels with the quote (closure/tld-https.ts), so every client shows it before checkout.
        return json({
          availability: { fqdn: a.fqdn, kind: a.kind, source: a.source, unconfirmed: a.unconfirmed }, quote: purchasable ? quoteToJson(quote) : null, notices: tldNotices(a.fqdn),
          sales_open: !facts.paused,
          registrar: { name: rec.name, short: rec.short, iana_id: rec.ianaId },
          refund: { refundable: facts.refund.refundable, window_days: facts.refund.refundable ? Math.min(5, facts.refund.windowDays ?? 5) : 0 },
        });
      },
    },
  );
  return router;
}
