import { connect } from "@mosshatch/db";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import { loadConfig } from "./config/modeguard.ts";
import { LocalKms, LocalPii } from "./kms.ts";
import { systemClock, type AppContext } from "./ports.ts";
import { createEmailTransport } from "./mail/transport.ts";
import { NodeDnsResolver } from "./mail/dns.ts";
import { MemoryAnchorSink } from "./ops/anchor.ts";
import { MemoryErasureLedger } from "./ops/erasure.ts";
import { FakeCloudTrail } from "./ops/kms-reconcile.ts";
import { StripeReal } from "./stripe/real.ts";
import { installOrders } from "./orders/wiring.ts";
import { registerOrderJobs } from "./orders/jobs.ts";
import { registerOpsJobs } from "./ops/jobs.ts";
import { opportunisticTick } from "./jobs/engine.ts";
import { buildRouter } from "./routes.ts";
import type { Router } from "./http/router.ts";
import { FakeStripe } from "./stripe/fake.ts";

export class NotConfigured extends Error {
  override name = "NotConfigured";
  constructor(public reason: string) { super(reason); }
}

export interface Boot { router: Router; ctx: AppContext }

/**
 * Assemble the running app from environment variables. Throws NotConfigured with a reason code (never a value) when a piece
 * is missing, so the function answers 503 instead of guessing. Production is refused until its adapters exist:
 * the AWS KMS HMAC/PII adapter, the write-once anchor bucket and the live OpenSRS adapter are not built in this phase.
 */
export async function bootFromEnv(env: Record<string, string | undefined>): Promise<Boot> {
  const config = loadConfig(env);
  if (config.mode === "production") throw new NotConfigured("production_adapters_not_built");
  if (!env.DATABASE_URL) throw new NotConfigured("database_not_configured");
  const root = env.MH_LOCAL_KMS_ROOT;
  if (config.mode !== "local" && (!root || root.length < 32)) throw new NotConfigured("kms_root_not_configured");
  const ctx: AppContext = {
    runtime: connect(env.DATABASE_URL, { max: 5 }),
    cron: connect(env.DATABASE_URL_CRON ?? env.DATABASE_URL, { max: 5 }),
    clock: systemClock,
    kms: root ? new LocalKms(Buffer.from(root)) : new LocalKms(),
    pii: root ? new LocalPii(Buffer.from(root)) : new LocalPii(),
    email: createEmailTransport(config, { log: (l) => console.info(l) }),
    config,
    services: {},
  };
  // Non-durable stand-ins for the daily ops jobs (preview and local only; production wiring uses the write-once bucket, CloudTrail and an external ledger).
  Object.assign(ctx.services, {
    anchorSink: new MemoryAnchorSink(), cloudTrail: new FakeCloudTrail(), erasureLedger: new MemoryErasureLedger(),
    dnsResolver: new NodeDnsResolver(), alertNotifier: { notify: async (a: { kind: string }) => { console.warn("alert", a.kind); } },
  });
  // Phases 1 and 2 use the mock registrar (sample prices) everywhere; the live OpenSRS adapter arrives in Phase 3.
  // The mock is priced from the same effective-dated table the quotes use, so the price guard sees one price on both sides.
  const rows = (await ctx.cron.query("select distinct on (tld) tld, amount_minor from wholesale_prices where registrar = 'opensrs' and kind = 'register' and effective_from <= $1::date order by tld, effective_from desc", [ctx.clock.now()])).rows;
  const wholesale = Object.fromEntries(rows.map((r) => [r.tld as string, BigInt(r.amount_minor)]));
  const registrar = new MockRegistrarPort({ clock: ctx.clock, wholesalePerYear: wholesale });
  (ctx.services as Record<string, unknown>).registrar = registrar;
  const router = buildRouter();
  registerOrderJobs();
  registerOpsJobs();
  if (env.STRIPE_SECRET_KEY) {
    const stripe = new StripeReal({ apiKey: env.STRIPE_SECRET_KEY, mode: config.mode, registrarMode: config.registrarMode, vercelEnv: env.VERCEL_ENV as never });
    installOrders(ctx, { stripe, registrar, tick: (c) => { opportunisticTick(c, () => undefined); } });
  } else if (config.mode === "local" && env.MH_FAKE_STRIPE === "1") {
    installOrders(ctx, { stripe: new FakeStripe(ctx.clock, { livemode: false, taxBps: 0 }), registrar });
  }
  return { router, ctx };
}
