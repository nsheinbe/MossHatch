import { withUser } from "@mosshatch/db";
import { HttpError, json, type Router } from "../http/router.ts";
import type { HandlerReq } from "../http/types.ts";
import { hit } from "../ratelimit.ts";
import { appendAudit } from "../audit.ts";
import { loadRegistrant, RegistrantBody, storeRegistrant } from "../orders/registrant.ts";
import { authRoutes } from "../auth/routes.ts";
import { liveAccessFor } from "../waitlist/gate.ts";

const UID = (r: HandlerReq) => { if (!r.principal.userId) throw new HttpError(401, "unauthorized"); return r.principal.userId; };

export function registerAccountRoutes(router: Router): Router {
  const meRoute = authRoutes.find((r) => r.method === "GET" && r.path === "/api/v1/me");
  router.add(
    {
      // Who am I, without an error status when nobody is signed in: the page asks on every load, and a 401 would print a console error each time.
      method: "GET", path: "/api/v1/session", principals: ["anonymous", "session"], tag: "account",
      async handler(r) {
        // `live_access`: whether this account may use the shop (always, unless the invite-only live gate is on; then only invited accounts).
        // The web shows the demo (banner, practice hatch, waitlist) to everyone else from the same build.
        const gated = (r.ctx.services as { liveGate?: boolean }).liveGate === true;
        if (r.principal.kind !== "session" || !meRoute) return json({ signedIn: false, live_gate: gated });
        const res = await meRoute.handler(r);
        return { ...res, json: { signedIn: true, ...(res.json as object), live_gate: gated, live_access: await liveAccessFor(r.ctx, r.principal.userId) } };
      },
    },
    {
      // Which documents are in force, for the acceptance line at checkout.
      method: "GET", path: "/api/v1/documents", principals: ["anonymous", "session"], tag: "account",
      async handler(r) {
        // Checkout shows two documents. The domain panel asks for the auto-renew authorisation as well with ?include=auto_renew (it is consented to apart from the terms).
        const include = (new URL(r.request.url).searchParams.get("include") ?? "").split(",");
        const kinds = ["terms", "registration_agreement", ...(include.includes("auto_renew") ? ["auto_renew_authorisation"] : [])];
        // Checkout for .ai or .io also shows that registry's terms, accepted with the others (C-59, C-60).
        for (const t of ["ai", "io"]) if (include.includes(`tld_${t}`)) kinds.push(`tld_addendum_${t}`);
        const rows = (await r.ctx.cron.query(
          "select distinct on (kind) kind, version_hash from document_versions where kind = any($2) and effective_at <= $1 and (retired_at is null or retired_at > $1) order by kind, effective_at desc", [r.ctx.clock.now(), kinds])).rows;
        const path: Record<string, string> = { terms: "/legal/terms.html", registration_agreement: "/legal/registration-agreement.html", auto_renew_authorisation: "/legal/auto-renew-authorisation.html",
          tld_addendum_ai: "/legal/tld-addendum-ai.html", tld_addendum_io: "/legal/tld-addendum-io.html" };
        return json({ documents: rows.map((d) => ({ kind: d.kind, version: d.version_hash, url: path[d.kind as string] })) });
      },
    },
    {
      method: "GET", path: "/api/v1/contact", principals: ["session"], tag: "account",
      async handler(r) {
        const reg = await loadRegistrant(r.ctx, UID(r));
        return json(reg ? { present: true, name: reg.name, email: reg.email, country: reg.country } : { present: false });
      },
    },
    {
      // The registrant contact (C-15). The email must be one of the person's verified addresses, so ICANN verification has a real mailbox behind it.
      // The phone is read in any usual form and stored as `+CC.number` (orders/registrant.ts RegistrantBody).
      method: "POST", path: "/api/v1/contact", principals: ["session"], tag: "account",
      async handler(r) {
        const userId = UID(r);
        const parsed = RegistrantBody.safeParse(r.body);
        if (!parsed.success) throw new HttpError(422, "invalid_contact");
        const c = parsed.data;
        await withUser(r.ctx.runtime, userId, async (db) => {
          const lim = await hit(r.ctx, db, `contact:${userId}`, { bucket: "contact", max: 10, windowSeconds: 3600 });
          if (!lim.allowed) throw new HttpError(429, "rate_limited", "rate_limited", { "Retry-After": String(lim.retryAfterSeconds) });
          const ok = (await db.query("select 1 from notification_addresses where user_id = $1 and address = $2 and verified_at is not null and removed_at is null", [userId, c.email])).rowCount;
          if (!ok) throw new HttpError(422, "email_not_verified");
          await storeRegistrant(r.ctx, db, userId, c);
          await appendAudit(r.ctx, db, { chainId: userId, actorKind: "user", actorId: userId, action: "contact.saved", resourceKind: "contact" });
        });
        return json({ present: true }, 201);
      },
    },
  );
  return router;
}
