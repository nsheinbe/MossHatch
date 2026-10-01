import type { AppContext } from "../ports.ts";
import type { AnchorSink } from "./anchor.ts";
import type { CloudTrailPort } from "./kms-reconcile.ts";
import type { ErasureLedger } from "./erasure.ts";
import type { DnsResolver } from "../mail/dns.ts";

/** Injectable dependencies of the ops jobs, carried in `ctx.services`. Production wiring fills these; tests pass fakes. */
export interface OpsServices {
  anchorSink: AnchorSink;
  cloudTrail: CloudTrailPort;
  erasureLedger: ErasureLedger;
  dnsResolver: DnsResolver;
  alertNotifier: AlertNotifier;
}

/** Push and email delivery of S1 alerts. The real one (phone push plus two addresses) is wired outside this repo's tests. */
export interface AlertNotifier {
  notify(alert: { id: string; severity: "info" | "warn" | "page"; kind: string; subject: string | null }): Promise<void>;
}

export class MissingServiceError extends Error {
  override name = "MissingServiceError";
  constructor(public service: string) { super(`missing service: ${service}`); }
}

export function svc<K extends keyof OpsServices>(ctx: Pick<AppContext, "services">, key: K): OpsServices[K] {
  const v = (ctx.services as Partial<OpsServices>)[key];
  if (!v) throw new MissingServiceError(key);
  return v;
}
export function optSvc<K extends keyof OpsServices>(ctx: Pick<AppContext, "services">, key: K): OpsServices[K] | undefined {
  return (ctx.services as Partial<OpsServices>)[key];
}
