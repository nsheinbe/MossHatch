import type { AppContext } from "../ports.ts";
import type { DomainsServices, EndUserProbe } from "./common.ts";

/** Put the domains services on the context. The end-user probe is a fake in tests; the real one is a Horizon test profile's HTTP login. */
export function installDomains(ctx: AppContext, s: DomainsServices): DomainsServices {
  (ctx.services as Record<string, unknown>).domains = s;
  return s;
}

/** A scripted end-user interface: `verdict` is what a probe login sees. */
export class FakeEndUserProbe implements EndUserProbe {
  verdict: "redirects" | "reachable" | "unreachable" = "redirects";
  calls: string[] = [];
  async probeLogin(profileUsername: string) { this.calls.push(profileUsername); return { verdict: this.verdict }; }
}
