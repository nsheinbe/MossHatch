import { connect } from "@mosshatch/db";
import { MockRegistrarPort } from "@mosshatch/registrar/mock-port";
import { loadConfig, modeFromEnv } from "./config/modeguard.ts";
import { LocalKms, LocalPii } from "./kms.ts";
import { systemClock, type AppContext } from "./ports.ts";
import { createEmailTransport, resendFromEnv } from "./mail/transport.ts";
import { NodeDnsResolver } from "./mail/dns.ts";
import { MemoryAnchorSink } from "./ops/anchor.ts";
import { MemoryErasureLedger } from "./ops/erasure.ts";
import { FakeCloudTrail } from "./ops/kms-reconcile.ts";
import { StripeReal } from "./stripe/real.ts";
import { installOrders } from "./orders/wiring.ts";
import { registerOrderJobs } from "./orders/jobs.ts";
import { registerOpsJobs } from "./ops/jobs.ts";
import { opportunisticTick } from "./jobs/engine.ts";
import { requestWaitUntil, tickConcurrency } from "./jobs/lifecycle.ts";
import { buildRouter } from "./routes.ts";
import type { Router } from "./http/router.ts";
import { FakeStripe } from "./stripe/fake.ts";
import { publishFromEnv } from "./publish/wiring.ts";
import { installPublish } from "./publish/service.ts";
import { installDomainsFromEnv, registrarFromEnv } from "./domains/boot-wiring.ts";
import { installVaultFromEnv } from "./vault/wiring.ts";
import { installRecipesFromEnv } from "./recipes/wiring.ts";
import { installClosureFromEnv } from "./closure/services.ts";
import { inviteOnlyFromEnv, liveGateFromEnv } from "./waitlist/gate.ts";
import { configurePriceTables, defaultPriceTable } from "./pricing/registrar.ts";
import { spendFuseFromEnv } from "./compliance/velocity.ts";
import { buildProductionAws, probeProductionAws, productionAwsFromEnv, type AwsDeps, type ProductionAwsAdapters } from "./aws/production.ts";
// api/index.ts runs each request inside this, so the AWS credential providers can read the request's OIDC token.
export { runWithOidcToken } from "./aws/oidc.ts";
// The waitlist is served by api/index.ts before (and without) the full boot, so it works while production refuses to start.
export { handleWaitlist } from "./waitlist/http.ts";
// The preview's registered-or-not check (public RDAP) needs no database either, and is served the same way.
export { handleLookup } from "./lookup/http.ts";

/** Why the app will not start: one or more reason codes (never a value), joined with commas in `reason`. */
export class NotConfigured extends Error {
  override name = "NotConfigured";
  readonly reasons: string[];
  readonly reason: string;
  constructor(reason: string | string[]) {
    const reasons = Array.isArray(reason) ? reason : [reason];
    super(reasons.join(","));
    this.reasons = reasons;
    this.reason = reasons.join(",");
  }
}

export interface Boot { router: Router; ctx: AppContext }

/**
 * The live money paths (Stripe live Checkout and webhooks; Openprovider live through the `registrar` project) are wired for the
 * invite-only dogfood (D-058, docs/GO-LIVE.md). Setting either back to false makes a production boot refuse with
 * `stripe_live_not_configured` / `registrar_live_not_configured` whatever the variables say (a code-level kill for a release).
 */
export const PRODUCTION_LIVE_WIRED = { stripe: true, registrar: true } as const;

/** The live money paths' variables, as reason codes (pure; names only, never a value). docs/GO-LIVE.md lists each one. */
export function liveMoneyReasons(env: Record<string, string | undefined>): string[] {
  const reasons: string[] = [];
  if (env.VERCEL_ENV !== "production") reasons.push("vercel_env_not_production");
  const key = env.STRIPE_SECRET_KEY ?? "";
  if (!key) reasons.push("stripe_secret_key_missing");
  else if (!/^(sk|rk)_live_/.test(key)) reasons.push("stripe_key_not_live");
  if (!/^whsec_\S{8,}$/.test(env.STRIPE_WEBHOOK_SECRET ?? "")) reasons.push("stripe_webhook_secret_missing");
  if (!PRODUCTION_LIVE_WIRED.stripe) reasons.push("stripe_live_not_configured");
  if (env.MH_REGISTRAR_MODE !== "live") reasons.push("registrar_mode_not_live");
  // Live sales go through Openprovider only: the OpenSRS adapter has never seen a real response (docs/registrar-parity.md).
  if ((env.MH_REGISTRAR_PROVIDER ?? "").trim().toLowerCase() !== "openprovider" || (env.MH_REGISTRAR_PROVIDER_BY_TLD ?? "").trim() !== "") reasons.push("registrar_provider_not_openprovider");
  if (!env.REGISTRAR_RPC_URL) reasons.push("registrar_rpc_url_missing");
  if (!env.REGISTRAR_RPC_SECRET || env.REGISTRAR_RPC_SECRET.length < 32) reasons.push("registrar_rpc_secret_missing");
  if (!PRODUCTION_LIVE_WIRED.registrar) reasons.push("registrar_live_not_configured");
  return reasons;
}

/**
 * Every production reason code at once, so one 503 names everything still missing. Order: database, app config, AWS
 * (OIDC, KMS, anchor, vault), then the live money paths. When the AWS variables are complete the adapters are built and
 * probed live (STS, KMS MAC and PII round trips, the bucket's Object Lock), so a wrong ARN or policy shows up here too.
 * The registrar project itself is reached after this (registrarFromEnv), and its own problems come back as their codes
 * (`openprovider_credentials_missing`, `registrar_rpc_secret_mismatch`, ...).
 */
async function productionPreflight(env: Record<string, string | undefined>, deps: AwsDeps): Promise<ProductionAwsAdapters> {
  const reasons: string[] = [];
  if (!env.DATABASE_URL) reasons.push("database_not_configured");
  if (!env.MH_ORIGIN) reasons.push("origin_not_configured");
  if (!env.CRON_SECRET || env.CRON_SECRET.length < 32) reasons.push("cron_secret_not_configured");
  if (!env.RESEND_API_KEY) reasons.push("email_not_configured");
  const aws = productionAwsFromEnv(env);
  reasons.push(...aws.reasons);
  let adapters: ProductionAwsAdapters | null = null;
  if (aws.config) {
    adapters = buildProductionAws(aws.config, env, deps);
    reasons.push(...await probeProductionAws(adapters, aws.config));
  }
  reasons.push(...liveMoneyReasons(env));
  if (reasons.length || !adapters) throw new NotConfigured(reasons);
  return adapters;
}

/**
 * Assemble the running app from environment variables. Throws NotConfigured with reason codes (never a value) when a piece
 * is missing, so the function answers 503 instead of guessing. Production uses AWS KMS through Vercel OIDC, the Object Lock
 * anchor bucket and CloudTrail (packages/api/src/aws, docs/AWS-SETUP.md); local and preview use the local doubles.
 * `deps` lets tests replace the network and the OIDC token source; production passes nothing.
 */
export async function bootFromEnv(env: Record<string, string | undefined>, deps: AwsDeps = {}): Promise<Boot> {
  const production = modeFromEnv(env) === "production" ? await productionPreflight(env, deps) : null;
  const config = loadConfig(env);
  if (!env.DATABASE_URL) throw new NotConfigured("database_not_configured");
  const root = env.MH_LOCAL_KMS_ROOT;
  if (!production && config.mode !== "local" && (!root || root.length < 32)) throw new NotConfigured("kms_root_not_configured");
  const ctx: AppContext = {
    runtime: connect(env.DATABASE_URL, { max: 5 }),
    cron: connect(env.DATABASE_URL_CRON ?? env.DATABASE_URL, { max: 5 }),
    clock: systemClock,
    kms: production ? production.kms : root ? new LocalKms(Buffer.from(root)) : new LocalKms(),
    pii: production ? production.pii : root ? new LocalPii(Buffer.from(root)) : new LocalPii(),
    email: createEmailTransport(config, { log: (l) => console.info(l), resend: resendFromEnv(env) }),
    config,
    services: {},
  };
  // Production: the write-once bucket (anchors and the erasure ledger) and CloudTrail. Elsewhere: non-durable stand-ins.
  Object.assign(ctx.services, production
    ? { anchorSink: production.anchorSink, cloudTrail: production.cloudTrail, erasureLedger: production.erasureLedger }
    : { anchorSink: new MemoryAnchorSink(), cloudTrail: new FakeCloudTrail(), erasureLedger: new MemoryErasureLedger() });
  Object.assign(ctx.services, { dnsResolver: new NodeDnsResolver(), alertNotifier: { notify: async (a: { kind: string }) => { console.warn("alert", a.kind); } } });
  // Quotes read the price table of the registrar that will be charged (MH_REGISTRAR_PROVIDER: openprovider rows in production).
  configurePriceTables(env);
  // The mock (local and preview) is priced from the same effective-dated table the quotes use, so the price guard sees one price on both sides.
  const rows = (await ctx.cron.query("select distinct on (tld) tld, amount_minor from wholesale_prices where registrar = $2 and kind = 'register' and effective_from <= $1::date order by tld, effective_from desc", [ctx.clock.now(), defaultPriceTable()])).rows;
  const wholesale = Object.fromEntries(rows.map((r) => [r.tld as string, BigInt(r.amount_minor)]));
  // Phase 3: a sandbox or live process reaches OpenSRS only through the signed RPC to the `registrar` project; the mock stays for MH_REGISTRAR_MODE=mock.
  const registrar = (await registrarFromEnv(env, config)) ?? new MockRegistrarPort({ clock: ctx.clock, wholesalePerYear: wholesale });
  // The adapter behind the RPC must be the mode this process was configured for (a sandbox registrar project behind a live web is refused).
  if (registrar.capabilities().mode !== config.registrarMode) throw new NotConfigured("registrar_mode_mismatch");
  (ctx.services as Record<string, unknown>).registrar = registrar;
  const router = buildRouter();
  const pub = publishFromEnv(env, config.mode);
  if (pub) installPublish(ctx, pub);
  registerOrderJobs();
  registerOpsJobs();
  if (env.STRIPE_SECRET_KEY) {
    const stripe = new StripeReal({ apiKey: env.STRIPE_SECRET_KEY, mode: config.mode, registrarMode: config.registrarMode, vercelEnv: env.VERCEL_ENV as never });
    installOrders(ctx, { stripe, registrar, registrarId: defaultPriceTable(), tick: (c) => { opportunisticTick(c, requestWaitUntil(), { concurrency: tickConcurrency(env) }); } });
  } else if (config.mode === "local" && env.MH_FAKE_STRIPE === "1") {
    installOrders(ctx, { stripe: new FakeStripe(ctx.clock, { livemode: false, taxBps: 0 }), registrar });
  }
  // Phase 3: the domains services (the posture job's end-user probe). The domain and domain-management jobs are registered by buildRouter.
  installDomainsFromEnv(ctx, env);
  installVaultFromEnv(ctx, env, config.mode, production?.vaultKms ? { kms: production.vaultKms } : null);
  installRecipesFromEnv(ctx, config.mode);
  installClosureFromEnv(ctx, env);
  // Invite-only sign-up (the waitlist rollout): MH_INVITE_ONLY, on by default in staging and production.
  const inviteOnly = inviteOnlyFromEnv(env, config.mode);
  (ctx.services as Record<string, unknown>).inviteOnly = inviteOnly;
  // The invite-only live shop: in production only invited accounts reach the purchase routes; everyone else keeps the demo.
  (ctx.services as Record<string, unknown>).liveGate = liveGateFromEnv(env, config.mode);
  // The dogfood spend fuse: a live process takes at most 3 registrations a day and 10 in all unless MH_LIVE_* says fewer or more.
  (ctx.services as Record<string, unknown>).spendFuse = spendFuseFromEnv(env, config.livemode);
  return { router, ctx };
}
