import type { AppContext, Mode } from "../ports.ts";
import vercel from "../../../../vercel.json" with { type: "json" };
import { launcherConfigFromEnv, type LauncherConfig } from "./config.ts";
import { AnthropicCreature, type CreaturePort } from "./claude.ts";
import { FakeCreature } from "./claude-fake.ts";
import { SlateHttp, type SlatePort } from "./slate.ts";
import { FakeSlate } from "./slate-fake.ts";
import type { LauncherServices } from "./service.ts";

export { registerLauncher } from "./routes.ts";
export * from "./service.ts";
export { launcherConfigFromEnv, priceWithMarkup } from "./config.ts";
export { FakeCreature } from "./claude-fake.ts";
export { FakeSlate } from "./slate-fake.ts";
export * as slate from "./slate.ts";
export * as credits from "./credits.ts";

/** The page's CSP as deployed (vercel.json, bundled at build time): whether its `frame-src` lets the page frame `origin`. */
export function frameSrcAllows(csp: string, origin: string): boolean {
  const d = csp.split(";").map((x) => x.trim().split(/\s+/)).find((x) => x[0] === "frame-src");
  return !!d && d.slice(1).includes(origin);
}
export function deployedCsp(): string {
  const all = (vercel as { headers: { source: string; headers: { key: string; value: string }[] }[] }).headers.find((h) => h.source === "/(.*)");
  return all?.headers.find((h) => h.key === "Content-Security-Policy")?.value ?? "";
}

/** Fake secrets for MH_FAKE_LAUNCHER=1 only (never a production value: the config refuses the fake in production). */
const FAKE = { partnerId: "mosshatch", secret: "fake-slate-partner-secret-0123456789abcdef", userKey: "fake-slate-partner-user-key-0123456789abcd" };

/**
 * Install the launcher from the environment. Returns the reason codes when it stays off (logged as codes at boot); the rest of the app
 * boots either way. `origin` is the app origin (the dev server serves the fake's preview pages under it).
 */
export function installLauncherFromEnv(ctx: AppContext, env: Record<string, string | undefined>, mode: Mode, deps: { creature?: CreaturePort; slate?: SlatePort } = {}): string[] {
  const { config, reasons } = launcherConfigFromEnv(env, mode);
  if (!config) return reasons;
  (ctx.services as Record<string, unknown>).launcher = buildServices(ctx, config, deps);
  return [];
}

export function buildServices(ctx: AppContext, config: LauncherConfig, deps: { creature?: CreaturePort; slate?: SlatePort } = {}): LauncherServices {
  if (config.fake) {
    const previewOrigin = new URL(ctx.config.origin).origin;
    const fakeSlate = new FakeSlate({ ...FAKE, previewBase: `${previewOrigin}/__dev/slate/preview`, now: () => ctx.clock.now() });
    return {
      config, creature: deps.creature ?? new FakeCreature({ delayMs: 25 }),
      slate: deps.slate ?? new SlateHttp({ baseUrl: "http://localhost/api/partner/v1", ...FAKE, fetch: fakeSlate.fetch, now: () => ctx.clock.now() }),
      fakeSlate, previewOrigin, previewPath: "/__dev/slate/preview/", previewFraming: true,
    };
  }
  const s = config.slate!;
  return {
    config,
    creature: deps.creature ?? new AnthropicCreature({ apiKey: config.anthropicKey!, fallbacks: config.fallbacks }),
    slate: deps.slate ?? new SlateHttp({ baseUrl: s.baseUrl, partnerId: s.partnerId, secret: s.secret, userKey: s.userKey }),
    previewOrigin: config.previewOrigin!,
    previewPath: config.previewPath ?? "/",
    previewFraming: frameSrcAllows(deployedCsp(), config.previewOrigin!),
  };
}
