import crypto from "node:crypto";
import { z } from "zod";
import { withUser } from "@mosshatch/db";
import type { HandlerReq, HandlerResult, Route } from "../http/types.ts";
import { HttpError, json } from "../http/router.ts";
import { sendMail } from "../email.ts";
import { UUID_RE, auditUser, emailSchema, parseBody, rateLimited } from "./common.ts";
import { checkEmailCode, putEmailCode } from "./codes.ts";
import { assertNoRecoveryActivity } from "./holds.ts";
import { classAAllowed, notifyUser } from "./mail.ts";

const MAX_LIVE_ADDRESSES = 5;
const ADDRESS_CODE_TTL_MS = 30 * 60_000;

function uid(req: HandlerReq): string {
  if (req.principal.kind !== "session" || !req.principal.userId) throw new HttpError(401, "unauthorized");
  return req.principal.userId;
}

const view = (r: Record<string, any>) => ({ id: r.id as string, address: r.address as string, kind: r.kind as string, verified: !!r.verified_at });

async function list(req: HandlerReq): Promise<HandlerResult> {
  const userId = uid(req);
  const rows = await withUser(req.ctx.runtime, userId, (c) => c.query("select id, address::text as address, kind, verified_at from notification_addresses where user_id = $1 and removed_at is null order by created_at", [userId]));
  return json({ addresses: rows.rows.map(view) });
}

const addBody = z.object({ address: emailSchema, kind: z.enum(["second", "registrant"]) });

/** Add an address (unverified) and mail it a code. Every existing address is told; refused during a recovery hold. */
async function add(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = uid(req);
  const b = parseBody(addBody, req.body);
  const pre = await withUser(ctx.runtime, userId, async (c) => {
    await assertNoRecoveryActivity(ctx, c, userId);
    const live = (await c.query("select address::text as address from notification_addresses where user_id = $1 and removed_at is null", [userId])).rows as { address: string }[];
    if (live.some((r) => r.address.toLowerCase() === b.address)) throw new HttpError(409, "address_exists");
    if (live.length >= MAX_LIVE_ADDRESSES) throw new HttpError(409, "too_many_addresses");
    return true;
  });
  void pre;
  // The code mail is class A (an authenticated request can still be used to spam a third party's mailbox).
  const gate = await classAAllowed(ctx, b.address, "address");
  if (!gate.allowed) throw rateLimited(gate.retryAfterSeconds);
  const row = await withUser(ctx.runtime, userId, async (c) => {
    await assertNoRecoveryActivity(ctx, c, userId);
    const now = ctx.clock.now();
    // Told first, so the new address is not among the recipients of its own notice.
    await notifyUser(ctx, c, userId, { kind: "address.added", dedupeKey: `addr-add:${crypto.randomUUID()}`, subject: "A notification address was added to your Mosshatch account", text: "A new notification address was added and is waiting for verification. If this was not you, review your account at once." });
    const ins = await c.query("insert into notification_addresses (user_id, address, kind, created_at) values ($1,$2,$3,$4) returning id, address::text as address, kind, verified_at", [userId, b.address, b.kind, now]);
    const { id, code } = await putEmailCode(ctx, c, "address", b.address, userId, ADDRESS_CODE_TTL_MS);
    await sendMail(c, ctx.email, { dedupeKey: `addr-code:${id}`, kind: "address.code", userId, to: [b.address], klass: "A", subject: "Verify your Mosshatch notification address", text: `Your verification code is ${code}. It works for 30 minutes.` });
    await auditUser(ctx, c, userId, "auth.address.added", { resourceKind: "notification_address", resourceId: ins.rows[0].id, detail: { kind: b.kind } });
    return ins.rows[0];
  });
  return json({ address: view(row) }, 201);
}

const verifyBody = z.object({ code: z.string().trim().min(4).max(16) });

async function verify(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = uid(req);
  const id = req.params.id ?? "";
  if (!UUID_RE.test(id)) throw new HttpError(404, "not_found");
  const b = parseBody(verifyBody, req.body);
  const out = await withUser(ctx.runtime, userId, async (c) => {
    await assertNoRecoveryActivity(ctx, c, userId);
    const a = (await c.query("select id, address::text as address, kind, verified_at from notification_addresses where id = $1 and user_id = $2 and removed_at is null", [id, userId])).rows[0];
    if (!a) return { status: 404 as const };
    if (a.verified_at) return { status: 200 as const, row: a };
    const chk = await checkEmailCode(ctx, c, "address", a.address, b.code, { userId });
    if (!chk.ok) return { status: 400 as const };
    const up = await c.query("update notification_addresses set verified_at = $2, updated_at = $2 where id = $1 and verified_at is null returning id, address::text as address, kind, verified_at", [id, ctx.clock.now()]);
    if (up.rowCount !== 1) return { status: 404 as const };
    await auditUser(ctx, c, userId, "auth.address.verified", { resourceKind: "notification_address", resourceId: id });
    await notifyUser(ctx, c, userId, { kind: "address.verified", dedupeKey: `addr-verified:${id}`, subject: "A notification address was verified", text: "A notification address on your Mosshatch account was verified and now receives security notices." });
    return { status: 200 as const, row: up.rows[0] };
  });
  // Codes burn tries even when wrong, so the failure has to commit before it is reported.
  if (out.status === 404) throw new HttpError(404, "not_found");
  if (out.status === 400) throw new HttpError(400, "invalid_code");
  return json({ address: view(out.row) });
}

async function remove(req: HandlerReq): Promise<HandlerResult> {
  const { ctx } = req;
  const userId = uid(req);
  const id = req.params.id ?? "";
  if (!UUID_RE.test(id)) throw new HttpError(404, "not_found");
  await withUser(ctx.runtime, userId, async (c) => {
    await assertNoRecoveryActivity(ctx, c, userId);
    const a = (await c.query("select id, address::text as address, kind from notification_addresses where id = $1 and user_id = $2 and removed_at is null", [id, userId])).rows[0];
    if (!a) throw new HttpError(404, "not_found");
    if (a.kind === "login") throw new HttpError(409, "cannot_remove_login");
    const r = await c.query("update notification_addresses set removed_at = $3, updated_at = $3 where id = $1 and user_id = $2 and removed_at is null", [id, userId, ctx.clock.now()]);
    if (r.rowCount !== 1) throw new HttpError(404, "not_found");
    await auditUser(ctx, c, userId, "auth.address.removed", { resourceKind: "notification_address", resourceId: id, detail: { kind: a.kind } });
    // Every address is told, the removed one included.
    await notifyUser(ctx, c, userId, { kind: "address.removed", dedupeKey: `addr-rm:${id}`, subject: "A notification address was removed", text: "A notification address was removed from your Mosshatch account. If this was not you, review your account at once.", extraTo: [a.address] });
  });
  return json({ ok: true });
}

export const addressRoutes: Route[] = [
  { method: "GET", path: "/api/v1/notification-addresses", principals: ["session"], handler: list, tag: "auth" },
  { method: "POST", path: "/api/v1/notification-addresses", principals: ["session"], handler: add, tag: "auth" },
  { method: "POST", path: "/api/v1/notification-addresses/:id/verify", principals: ["session"], handler: verify, tag: "auth" },
  { method: "DELETE", path: "/api/v1/notification-addresses/:id", principals: ["session"], handler: remove, tag: "auth" },
];
