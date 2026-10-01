import { RegistrarError, type RegistrarPort } from "@mosshatch/registrar/port";
import type { AppContext, Config } from "../ports.ts";
import { connectRegistrarRpc, type RpcSend } from "../registrar-rpc/client.ts";
import type { DomainsServices, EndUserProbe } from "./common.ts";
import { installDomains } from "./wiring.ts";

/**
 * What `bootFromEnv` needs from the Phase 3 modules, kept here so boot.ts only gains call lines.
 *
 *  - The registrar: the mock (sample prices) when `MH_REGISTRAR_MODE=mock`; otherwise the signed RPC client to the `registrar` project
 *    (`REGISTRAR_RPC_URL`, `REGISTRAR_RPC_SECRET`). `web` never holds the reseller key (ST-117). A missing or unreachable RPC target does
 *    not fall back to the mock: the process answers not-configured instead (a sandbox or live process must never sell sample names).
 *  - The domains services: the end-user interface probe for the nightly posture job (ST-113).
 */
export async function registrarFromEnv(env: Record<string, string | undefined>, config: Pick<Config, "registrarMode">, fetchImpl: typeof fetch = fetch): Promise<RegistrarPort | null> {
  if (config.registrarMode === "mock") return null;
  const { NotConfigured } = await import("../boot.ts");
  const url = env.REGISTRAR_RPC_URL, secret = env.REGISTRAR_RPC_SECRET;
  if (!url || !secret || secret.length < 32) throw new NotConfigured("registrar_rpc_not_configured");
  let base: URL;
  try { base = new URL(url); } catch { throw new NotConfigured("registrar_rpc_not_configured"); }
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) throw new NotConfigured("registrar_rpc_not_configured");
  const send: RpcSend = async (req) => {
    const res = await fetchImpl(new URL(req.path, base), { method: req.method, headers: req.headers, body: req.body, redirect: "error", signal: AbortSignal.timeout(25_000) });
    return { status: res.status, body: await res.text() };
  };
  try { return await connectRegistrarRpc({ secret, send }); }
  catch (e) { throw new NotConfigured(registrarRpcBootReason(e)); }
}

/**
 * Why the first signed call to the registrar project failed, as one reason code: the registrar project's own configuration codes come
 * through as they are (`openprovider_credentials_missing`, `registrar_scope_missing`, `live_outside_production`, ...; serve.ts), a
 * signature refusal is a secret that differs between the two projects, anything else is unreachable.
 */
export function registrarRpcBootReason(e: unknown): string {
  const code = e instanceof RegistrarError ? e.code ?? "" : "";
  if (code === "unauthorized") return "registrar_rpc_secret_mismatch";
  if (code === "rpc_not_configured") return "registrar_project_secret_missing";
  if (/^(openprovider_[a-z_]+|registrar_[a-z_]+|live_outside_production|live_registrar_key_outside_production)$/.test(code)) return code;
  return "registrar_rpc_unreachable";
}

/**
 * The mock registrar has no end-user interface at all, so a probe of it has nothing to reach: this stand-in answers `redirects` and is
 * installed only for a local process on the mock registrar. It proves nothing about OpenSRS and says so in its name.
 */
export class MockRegistrarNoEndUserInterface implements EndUserProbe {
  readonly label = "mock-registrar-has-no-end-user-interface";
  async probeLogin(): Promise<{ verdict: "redirects" }> { return { verdict: "redirects" }; }
}

/**
 * GET the registrar's end-user login page without following redirects: `redirects` when it answers 3xx to another origin, `reachable` when it
 * serves the page, `unreachable` otherwise. UNVERIFIED against Horizon: the plan's probe logs in with a test profile, which needs a registrar
 * credential that only the `registrar` project may hold; this web-side probe checks only that the page itself sends visitors away.
 */
export class HttpEndUserProbe implements EndUserProbe {
  constructor(private url: string, private fetchImpl: typeof fetch = fetch) {}
  async probeLogin(): Promise<{ verdict: "redirects" | "reachable" | "unreachable" }> {
    try {
      const res = await this.fetchImpl(this.url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location") ?? "";
        const same = (() => { try { return new URL(loc, this.url).origin === new URL(this.url).origin; } catch { return false; } })();
        return { verdict: same ? "reachable" : "redirects" };
      }
      return { verdict: res.status < 300 ? "reachable" : "unreachable" };
    } catch { return { verdict: "unreachable" }; }
  }
}

/** Put the domains services on the context from the environment. Absent probe settings leave the posture job raising its warning, as designed. */
export function installDomainsFromEnv(ctx: AppContext, env: Record<string, string | undefined>): DomainsServices {
  const url = env.MH_ENDUSER_PROBE_URL, profile = env.MH_ENDUSER_PROBE_PROFILE;
  if (url && profile) return installDomains(ctx, { endUserProbe: new HttpEndUserProbe(url), probeProfile: profile });
  if (ctx.config.mode === "local" && ctx.config.registrarMode === "mock") return installDomains(ctx, { endUserProbe: new MockRegistrarNoEndUserInterface(), probeProfile: "mock" });
  return installDomains(ctx, {});
}
