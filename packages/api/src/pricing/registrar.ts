import { parseRegistrarRouting, type ProviderName } from "@mosshatch/registrar/openprovider";

/**
 * Which registrar's rows (`wholesale_prices`, `tld_policy`) price an extension. It follows the registrar routing
 * (`MH_REGISTRAR_PROVIDER`, `MH_REGISTRAR_PROVIDER_BY_TLD`), so the quote is priced from the same upstream that will be charged:
 *   openprovider -> 'openprovider' rows (migration 1120); opensrs -> 'opensrs' rows; mock -> 'opensrs' rows (the plan's sample table).
 * Set once by `bootFromEnv` (every boot resets it, so a test process never inherits another boot's routing). Pure lookups otherwise.
 */
export type PriceTable = "opensrs" | "openprovider";
const tableOf = (p: ProviderName): PriceTable => (p === "openprovider" ? "openprovider" : "opensrs");

let current: { defaultTable: PriceTable; byTld: Record<string, PriceTable> } = { defaultTable: "opensrs", byTld: {} };

/** Set the price table routing from the environment. Throws on an unparseable routing (the config guard refuses it first). */
export function configurePriceTables(env: Record<string, string | undefined>): void {
  const r = parseRegistrarRouting(env);
  current = { defaultTable: tableOf(r.defaultProvider), byTld: Object.fromEntries(Object.entries(r.byTld).map(([t, p]) => [t, tableOf(p)])) };
}
/** Back to the default (OpenSRS sample rows); for tests. */
export function resetPriceTables(): void { current = { defaultTable: "opensrs", byTld: {} }; }
export function priceTableFor(tld: string): PriceTable { return current.byTld[tld] ?? current.defaultTable; }
export function defaultPriceTable(): PriceTable { return current.defaultTable; }
