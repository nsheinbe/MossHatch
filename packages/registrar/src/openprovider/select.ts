import { RegistrarError, type RegistrarPort } from "../port.ts";
import type { KillSwitch } from "../opensrs/guards.ts";
import { OpenproviderAdapter, type Deployment, type OpenproviderCredentials } from "./adapter.ts";
import { fetchTransport, type OpHttpTransport } from "./transport.ts";

/**
 * Registrar selection by environment (read in the `registrar` project, which is the only place reseller credentials exist):
 *  - `MH_REGISTRAR_PROVIDER=openprovider|opensrs|mock` picks the provider for every extension (default: `mock` when MH_REGISTRAR_MODE is mock
 *    or unset, otherwise `opensrs`, the plan's primary).
 *  - `MH_REGISTRAR_PROVIDER_BY_TLD=com=openprovider,io=opensrs` overrides it per extension.
 * Account-wide calls (balance, funding, inventory, deleted names, transfers away, pending-order cancel, health, capabilities) go to the default
 * provider only; a split setup must read the other provider's account through its own adapter.
 */
export type ProviderName = "openprovider" | "opensrs" | "mock";
export const PROVIDERS: readonly ProviderName[] = ["openprovider", "opensrs", "mock"];
export interface RegistrarRouting { defaultProvider: ProviderName; byTld: Record<string, ProviderName> }

const bad = () => new RegistrarError("rejected", "registrar provider setting is invalid", { retryable: false, outcomeUnknown: false, code: "registrar_provider_invalid" });

export function parseRegistrarRouting(env: Record<string, string | undefined>): RegistrarRouting {
  const mode = env.MH_REGISTRAR_MODE ?? "mock";
  const raw = (env.MH_REGISTRAR_PROVIDER ?? "").trim().toLowerCase();
  const defaultProvider = (raw || (mode === "mock" ? "mock" : "opensrs")) as ProviderName;
  if (!PROVIDERS.includes(defaultProvider)) throw bad();
  const byTld: Record<string, ProviderName> = {};
  for (const part of (env.MH_REGISTRAR_PROVIDER_BY_TLD ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^\.?([a-z0-9-]{2,24})=([a-z]+)$/.exec(part.toLowerCase());
    if (!m || !PROVIDERS.includes(m[2] as ProviderName) || byTld[m[1]!]) throw bad();
    byTld[m[1]!] = m[2] as ProviderName;
  }
  const used = new Set([defaultProvider, ...Object.values(byTld)]);
  // A live or sandbox process never routes an extension to the sample-price mock, and a mock process never reaches a real provider.
  if (mode !== "mock" && used.has("mock")) throw bad();
  if (mode === "mock" && [...used].some((p) => p !== "mock")) throw bad();
  return { defaultProvider, byTld };
}

const tldOf = (fqdn: string) => { const d = fqdn.trim().toLowerCase(); const i = d.indexOf("."); return i < 0 ? "" : d.slice(i + 1); };

/** One RegistrarPort over several providers, by extension. Built only when the routing names more than one provider. */
export class RoutedRegistrar implements RegistrarPort {
  constructor(private routing: RegistrarRouting, private ports: Partial<Record<ProviderName, RegistrarPort>>) {
    for (const p of new Set([routing.defaultProvider, ...Object.values(routing.byTld)])) if (!ports[p]) throw bad();
  }
  providerFor(fqdn: string): ProviderName { return this.routing.byTld[tldOf(fqdn)] ?? this.routing.defaultProvider; }
  private by(fqdn: string): RegistrarPort { return this.ports[this.providerFor(fqdn)]!; }
  private get main(): RegistrarPort { return this.ports[this.routing.defaultProvider]!; }
  capabilities() { return this.main.capabilities(); }
  health() { return this.main.health(); }
  checkAvailability: RegistrarPort["checkAvailability"] = (f, o) => this.by(f).checkAvailability(f, o);
  quote: RegistrarPort["quote"] = (f, y, k) => this.by(f).quote(f, y, k);
  register: RegistrarPort["register"] = (r) => this.by(r.fqdn).register(r);
  renew: RegistrarPort["renew"] = (f, y, c) => this.by(f).renew(f, y, c);
  getDomain: RegistrarPort["getDomain"] = (f) => this.by(f).getDomain(f);
  getOrdersByDomain: RegistrarPort["getOrdersByDomain"] = (f) => this.by(f).getOrdersByDomain(f);
  cancelPendingOrder: RegistrarPort["cancelPendingOrder"] = (id) => this.main.cancelPendingOrder(id);
  getFundingStatus: RegistrarPort["getFundingStatus"] = () => this.main.getFundingStatus();
  setLock: RegistrarPort["setLock"] = (f, l) => this.by(f).setLock(f, l);
  setNameservers: RegistrarPort["setNameservers"] = (f, n, o) => this.by(f).setNameservers(f, n, o);
  issueAuthCode: RegistrarPort["issueAuthCode"] = (f) => this.by(f).issueAuthCode(f);
  rerandomizeAuthCode: RegistrarPort["rerandomizeAuthCode"] = (f) => this.by(f).rerandomizeAuthCode(f);
  getDns: RegistrarPort["getDns"] = (f) => this.by(f).getDns(f);
  replaceZone: RegistrarPort["replaceZone"] = (f, r, o) => this.by(f).replaceZone(f, r, o);
  getDs: RegistrarPort["getDs"] = (f) => this.by(f).getDs(f);
  getDnssecCapabilities: NonNullable<RegistrarPort["getDnssecCapabilities"]> = async (f) => this.by(f).getDnssecCapabilities?.(f) ?? { supported: false, addMode: "unsupported", removeSupported: false, managedSigning: false };
  addDs: RegistrarPort["addDs"] = (f, d) => this.by(f).addDs(f, d);
  removeDs: RegistrarPort["removeDs"] = (f, d) => this.by(f).removeDs(f, d);
  updateContact: RegistrarPort["updateContact"] = (f, r) => this.by(f).updateContact(f, r);
  getTransfersAway: RegistrarPort["getTransfersAway"] = (o) => this.main.getTransfersAway(o);
  cancelTransfer: RegistrarPort["cancelTransfer"] = (f) => this.by(f).cancelTransfer(f);
  stopTransferAway: RegistrarPort["stopTransferAway"] = (f) => this.by(f).stopTransferAway(f);
  setAutoRenew: RegistrarPort["setAutoRenew"] = (f, e) => this.by(f).setAutoRenew(f, e);
  listDomains: RegistrarPort["listDomains"] = (o) => this.main.listDomains(o);
  getDeletedDomains: RegistrarPort["getDeletedDomains"] = () => this.main.getDeletedDomains();
  restore: RegistrarPort["restore"] = (f) => this.by(f).restore(f);
  getBalance: RegistrarPort["getBalance"] = () => this.main.getBalance();
  checkTransferIn: RegistrarPort["checkTransferIn"] = (f) => this.by(f).checkTransferIn(f);
  startTransferIn: RegistrarPort["startTransferIn"] = (r) => this.by(r.fqdn).startTransferIn(r);
  getTransferInStatus: RegistrarPort["getTransferInStatus"] = (f) => this.by(f).getTransferInStatus(f);
  cancelTransferIn: RegistrarPort["cancelTransferIn"] = (f) => this.by(f).cancelTransferIn(f);
}

/** Picks the single provider, or a RoutedRegistrar when extensions are split. Each factory is called at most once. */
export function selectRegistrar(env: Record<string, string | undefined>, factories: Partial<Record<ProviderName, () => RegistrarPort>>): RegistrarPort {
  const routing = parseRegistrarRouting(env);
  const used = [...new Set([routing.defaultProvider, ...Object.values(routing.byTld)])];
  const ports: Partial<Record<ProviderName, RegistrarPort>> = {};
  for (const p of used) { const f = factories[p]; if (!f) throw bad(); ports[p] = f(); }
  return used.length === 1 ? ports[used[0]!]! : new RoutedRegistrar(routing, ports);
}

/**
 * Builds the Openprovider adapter from `OPENPROVIDER_USERNAME`, `OPENPROVIDER_PASSWORD` and `OPENPROVIDER_ENV` (`sandbox` or `production`;
 * default sandbox). Credentials are read from `env` at each login, never copied elsewhere. `MH_MODE` is the deployment; the adapter refuses
 * production credentials outside production and sandbox credentials in production (the config guard refuses the same combinations at boot).
 */
export function openproviderFromEnv(env: Record<string, string | undefined>, deps: { killSwitch: KillSwitch; transport?: OpHttpTransport; onAlert?: ConstructorParameters<typeof OpenproviderAdapter>[0]["onAlert"]; log?: ConstructorParameters<typeof OpenproviderAdapter>[0]["log"] }): OpenproviderAdapter {
  const target = (env.OPENPROVIDER_ENV ?? "sandbox").toLowerCase();
  if (target !== "sandbox" && target !== "production") throw bad();
  const deployment = (["local", "preview", "staging", "production"].includes(env.MH_MODE ?? "") ? env.MH_MODE : "local") as Deployment;
  const credentials: OpenproviderCredentials = { read: () => ({ username: env.OPENPROVIDER_USERNAME ?? "", password: env.OPENPROVIDER_PASSWORD ?? "" }) };
  return new OpenproviderAdapter({
    mode: target === "production" ? "live" : "sandbox", deployment, credentials, transport: deps.transport ?? fetchTransport(), killSwitch: deps.killSwitch,
    ...(deps.onAlert ? { onAlert: deps.onAlert } : {}), ...(deps.log ? { log: deps.log } : {}),
  });
}
