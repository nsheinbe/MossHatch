import { afterEach, describe, expect, it, vi } from "vitest";
import { harnessPerTest, type DomainsHarness } from "../domains/testkit.ts";
import { pollTransfersIn } from "./jobs.ts";

const per = harnessPerTest();
afterEach(async () => { await per.dropAll(); vi.restoreAllMocks(); });
const POLL_MS = 5 * 60_000;

interface Fixture {
  id: string; fqdn: string; state: "pending_registry" | "failed" | "awaiting_confirmation";
  order_state: "captured" | "voided" | "checkout_open"; next_check_at: string | null; created_at: string;
  late_watch_until: string | null; failure: string | null; confirm_expires_at: string | null;
}
function fixture(n: number, now: Date, patch: Partial<Fixture> = {}): Fixture {
  return {
    id: "00000000-0000-4000-8000-" + String(n).padStart(12, "0"),
    fqdn: "poll-fairness-" + n + ".com", state: "pending_registry", order_state: "captured",
    next_check_at: new Date(now.getTime() - 60_000).toISOString(),
    created_at: new Date(now.getTime() - 3_600_000 + n).toISOString(),
    late_watch_until: null, failure: null, confirm_expires_at: null, ...patch,
  };
}

/** Synthetic captured/voided orders avoid Checkout or provider writes; polling still uses the real cron role and transfer driver. */
async function seed(h: DomainsHarness, rows: Fixture[]) {
  const userId = (await h.app.db.owner.query(
    "insert into users (email, status) values ('transfer-poll-fixture@example.test', 'active') returning id",
  )).rows[0].id;
  await h.app.db.owner.query(
    `with seed as (
       select * from jsonb_to_recordset($2::jsonb) as s(
         id uuid, fqdn text, state text, order_state text, next_check_at timestamptz, created_at timestamptz,
         late_watch_until timestamptz, failure text, confirm_expires_at timestamptz)
     ), inserted as (
       insert into orders (user_id, kind, fqdn_ascii, years, state, idempotency_key, request_hash, quote, subtotal_minor, total_minor, livemode, created_at)
       select $1, 'transfer_in', fqdn, 1, order_state, fqdn, decode('00','hex'), '{}'::jsonb, 0, 0, false, created_at from seed
       returning id, fqdn_ascii
     )
     insert into transfers_in (id, user_id, order_id, fqdn_ascii, tld, years, state, idempotency_key, request_hash,
       next_check_at, created_at, sent_at, late_watch_until, failure, confirm_expires_at)
     select s.id, $1, o.id, s.fqdn, 'com', 1, s.state, s.fqdn, decode('00','hex'),
       s.next_check_at, s.created_at, s.created_at, s.late_watch_until, s.failure, s.confirm_expires_at
     from seed s join inserted o on o.fqdn_ascii = s.fqdn`,
    [userId, JSON.stringify(rows)],
  );
}

describe("transfer-in polling fairness under a backlog (native PostgreSQL)", () => {
  it("visits all 1000 pending transfers across five bounded passes before repeating the oldest 200", async () => {
    const h = await per.make(), now = h.app.clock.now();
    const rows = Array.from({ length: 1000 }, (_, i) => fixture(i + 1, now));
    await seed(h, rows);
    const reads = vi.spyOn(h.registrar, "getTransferInStatus").mockImplementation(async (fqdn) => ({ fqdn, status: "pending_registry" as const }));
    const seen = new Set<string>();
    for (let pass = 0; pass < 5; pass++) {
      const offset = reads.mock.calls.length;
      expect((await pollTransfersIn(h.app.ctx)).polled).toBe(200);
      const batch = reads.mock.calls.slice(offset).map(([fqdn]) => fqdn);
      expect(batch).toEqual(rows.slice(pass * 200, (pass + 1) * 200).map((r) => r.fqdn));
      for (const fqdn of batch) { expect(seen.has(fqdn)).toBe(false); seen.add(fqdn); }
      h.app.clock.advance(POLL_MS);
    }
    expect(seen.size).toBe(1000);
    expect(reads).toHaveBeenCalledTimes(1000);
    expect((await h.app.db.owner.query("select count(*)::int n from transfers_in where state = 'pending_registry'")).rows[0].n).toBe(1000);
    expect((await h.app.db.owner.query("select count(*)::int n from orders where state = 'captured'")).rows[0].n).toBe(1000);

    const offset = reads.mock.calls.length;
    expect((await pollTransfersIn(h.app.ctx)).polled).toBe(200);
    expect(reads.mock.calls.slice(offset).map(([fqdn]) => fqdn)).toEqual(rows.slice(0, 200).map((r) => r.fqdn));
    expect(h.stripe.created.captures).toBe(0);
    expect(h.stripe.created.refunds).toBe(0);
    expect(h.registrar.calls.register).toBe(0);
    expect(h.registrar.calls.startTransferIn).toBe(0);
  }, 120_000);

  it("prioritizes never-checked rows, then the oldest due live/late-watch work, with deterministic ties and unchanged eligibility", async () => {
    const h = await per.make(), now = h.app.clock.now();
    const old = Array.from({ length: 200 }, (_, i) => fixture(i + 1, now));
    const never = Array.from({ length: 20 }, (_, i) => fixture(201 + i, now, {
      next_check_at: null, created_at: new Date(now.getTime() - 600_000).toISOString(),
    }));
    const late = Array.from({ length: 20 }, (_, i) => fixture(221 + i, now, {
      state: "failed", order_state: "voided", failure: "unknown_deadline",
      next_check_at: new Date(now.getTime() - 120_000).toISOString(),
      created_at: new Date(now.getTime() - 900_000).toISOString(),
      late_watch_until: new Date(now.getTime() + 86_400_000).toISOString(),
    }));
    const future = Array.from({ length: 5 }, (_, i) => fixture(241 + i, now, { next_check_at: new Date(now.getTime() + POLL_MS).toISOString() }));
    const expired = Array.from({ length: 5 }, (_, i) => fixture(246 + i, now, {
      state: "failed", order_state: "voided", failure: "unknown_deadline",
      late_watch_until: new Date(now.getTime() - 1).toISOString(),
    }));
    const unconfirmed = Array.from({ length: 5 }, (_, i) => fixture(251 + i, now, {
      state: "awaiting_confirmation", order_state: "checkout_open", created_at: now.toISOString(),
      confirm_expires_at: new Date(now.getTime() + 86_400_000).toISOString(),
    }));
    // Reverse physical insertion order: equal due/creation timestamps must still use the stable transfer id.
    await seed(h, [...old, ...never, ...late, ...future, ...expired, ...unconfirmed].reverse());
    const reads = vi.spyOn(h.registrar, "getTransferInStatus").mockImplementation(async (fqdn) => ({ fqdn, status: "pending_registry" as const }));
    const result = await pollTransfersIn(h.app.ctx);
    expect(result).toMatchObject({ expired: 0, polled: 200 });
    expect(reads.mock.calls.map(([fqdn]) => fqdn)).toEqual([...never, ...late, ...old.slice(0, 160)].map((r) => r.fqdn));
    expect((await h.app.db.owner.query(
      "select count(*)::int n from transfers_in where state = 'failed' and late_watch_until > $1 and next_check_at = $2",
      [now, new Date(now.getTime() + POLL_MS)],
    )).rows[0].n).toBe(20);
    expect(h.stripe.created.captures).toBe(0);
    expect(h.stripe.created.refunds).toBe(0);
    expect(h.registrar.calls.startTransferIn).toBe(0);
  });
});
