/**
 * The ICANN-accredited registrar of record behind a registrar table or `domains.registrar` value, for the checkout row, the domain
 * Overview and receipts (D-024 row 12, C-13). 'opensrs' is also the mock and sample path. Live names are at Openprovider, whose
 * accredited registrar is Hosting Concepts B.V., trading as Registrar.eu (IANA ID 1647; the fees page states the same).
 */
export interface RegistrarOfRecord { name: string; short: string; ianaId: number }

export function registrarOfRecord(registrar: string | null | undefined): RegistrarOfRecord {
  if (registrar === "openprovider") return { name: "Hosting Concepts B.V., trading as Registrar.eu and Openprovider", short: "Registrar.eu (Openprovider)", ianaId: 1647 };
  return { name: "Tucows Domains Inc. (OpenSRS)", short: "Tucows (OpenSRS)", ianaId: 69 };
}

/** ICANN's public lookup for a name: anyone can see its registrar of record there. */
export const icannLookupUrl = (fqdn: string): string => `https://lookup.icann.org/en/lookup?name=${encodeURIComponent(fqdn)}`;

/** ICANN's Registrants' Benefits and Responsibilities page (the RAA requires a link to it). */
export const REGISTRANT_RIGHTS_URL = "https://www.icann.org/resources/pages/benefits-2013-09-16-en";
