/**
 * C-58: .dev and .app are on the HSTS preload list (Chromium's transport_security_state_static.json lists both TLDs with
 * include_subdomains), so every browser reaches every name under them over HTTPS only, and registrars must say so at checkout. The
 * notice is shown at the quote and checkout, and in a recipe's plan before it writes DNS for such a name (the recipes' providers issue
 * TLS automatically; a record pointing elsewhere needs a certificate there).
 */
export const HSTS_PRELOADED_TLDS: readonly string[] = ["dev", "app"];

export interface TldNotice { code: "https_required"; text: string }

export const HTTPS_REQUIRED_TEXT = (tld: string) =>
  `.${tld} names work only over HTTPS: browsers refuse plain HTTP for every site and subdomain on .${tld}, so each one needs a TLS certificate before it serves anything.`;

export function tldOf(fqdn: string): string { return fqdn.toLowerCase().replace(/\.$/, "").split(".").pop() ?? ""; }
export const httpsRequired = (fqdn: string): boolean => HSTS_PRELOADED_TLDS.includes(tldOf(fqdn));

/** The notices to show with a quote, a checkout or a DNS-writing plan for this name. */
export function tldNotices(fqdn: string): TldNotice[] {
  const tld = tldOf(fqdn);
  return HSTS_PRELOADED_TLDS.includes(tld) ? [{ code: "https_required", text: HTTPS_REQUIRED_TEXT(tld) }] : [];
}
