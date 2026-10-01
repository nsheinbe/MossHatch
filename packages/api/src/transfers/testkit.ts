import { expect } from "vitest";
import { withUser } from "@mosshatch/db";
import { REGISTRANT } from "../orders/testkit.ts";
import { storeRegistrant } from "../orders/registrant.ts";
import { deliverAll, orderRow } from "../orders/testkit.ts";
import { makeDomainsHarness, makeOwner, settle, type DomainsHarness, type Owner } from "../domains/testkit.ts";
import { pollTransfersIn } from "./jobs.ts";

export { REGISTRANT };
/** The canary transfer code: it may appear on the registrar wire and nowhere else (ST-22). */
export const CODE = "Xc9Canary7Kq2wZp";

export interface TH extends DomainsHarness {}
export const makeTransfersHarness = async (): Promise<TH> => makeDomainsHarness();

export const docsAccept = async (h: TH) => Object.fromEntries((await h.app.db.owner.query("select kind, version_hash from document_versions where kind in ('terms','registration_agreement')")).rows.map((d) => [d.kind, d.version_hash]));

export async function startRescue(h: TH, o: Owner, fqdn: string, x: { years?: number; code?: string; key?: string; accept?: unknown } = {}) {
  return h.app.call("POST", "/api/v1/transfers", {
    cookie: o.cookie, headers: { "idempotency-key": x.key ?? `rescue-${fqdn}` },
    body: { fqdn, years: x.years ?? (fqdn.endsWith(".ai") ? 2 : 1), auth_code: x.code ?? CODE, accept: x.accept ?? await docsAccept(h) },
  });
}

/** The confirmation code from the newest mail to the registrant address for this name. */
export function confirmCodeOf(h: TH, fqdn: string): string {
  const m = [...h.app.email.sent].reverse().find((x) => x.kind === "transfer_confirm_code" && x.subject.includes(fqdn));
  expect(m, `confirm mail for ${fqdn}`).toBeTruthy();
  return /: ([A-Z0-9]{8})\n/.exec(m!.text)![1]!;
}

export const getTransfer = (h: TH, o: Owner, id: string) => h.app.call("GET", `/api/v1/transfers/${id}`, { cookie: o.cookie });
export const confirm = (h: TH, o: Owner, id: string, code: string) => h.app.call("POST", `/api/v1/transfers/${id}/confirm`, { cookie: o.cookie, body: { code } });
export const cancel = (h: TH, o: Owner, id: string) => h.app.call("POST", `/api/v1/transfers/${id}/cancel`, { cookie: o.cookie, body: {} });
export const transferRow = async (h: TH, id: string) => (await h.app.db.owner.query("select * from transfers_in where id = $1", [id])).rows[0];

/** Start, confirm by the emailed code, pay on Checkout (authorization only) and let the machine run. Returns ids. */
export async function rescueAndPay(h: TH, o: Owner, fqdn: string, x: Parameters<typeof startRescue>[3] = {}) {
  const s = await startRescue(h, o, fqdn, x);
  expect(s.status, s.text).toBe(201);
  const id = s.json.transfer_id as string, orderId = s.json.order_id as string;
  const c = await confirm(h, o, id, confirmCodeOf(h, fqdn));
  expect(c.status, c.text).toBe(200);
  expect(c.json.checkout_url).toMatch(/^https:\/\//);
  const row = await orderRow(h, orderId);
  h.stripe.takeEvents();
  h.stripe.payCheckout(row.stripe_checkout_session_id);
  await deliverAll(h);
  await settle(h);
  return { id, orderId };
}

/** Five minutes pass and every job that is due runs, including `transfer_in.poll` and `transfer.poll`. */
export async function pass(h: TH, ms = 5 * 60_000) {
  h.app.clock.advance(ms);
  await settle(h);
  await pollTransfersIn(h.app.ctx);
  await settle(h);
}

export async function ownerWithContact(h: TH, email: string, contact: Partial<typeof REGISTRANT> = {}): Promise<Owner> {
  const o = await makeOwner(h, email, { contact: false });
  await withUser(h.app.ctx.runtime, o.userId, (c) => storeRegistrant(h.app.ctx, c, o.userId, { ...REGISTRANT, email, ...contact }));
  return o;
}

export { makeOwner, settle };
