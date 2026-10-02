/**
 * How transfer texts name the registrar that holds a domain (`domains.registrar`). 'opensrs' is the mock and sample path, where Tucows
 * answers support. Live names are at Openprovider, whose transfer-away email and stop path are UNVERIFIED (docs/registrar-parity.md),
 * so those texts, and any other value, say "our registrar" rather than a sender the owner may not see.
 */
export interface RegistrarWords {
  /** Who sends the transfer email: "the email from <from>". */
  from: string;
  /** Sentence start: "<ours> emails the registrant ...". */
  ours: string;
  /** Who can end a pending transfer besides the owner. */
  support: string;
}

export function registrarWords(registrar: string | null | undefined): RegistrarWords {
  if (registrar === "opensrs") return { from: "OpenSRS", ours: "Our registrar, OpenSRS,", support: "Tucows support" };
  return { from: "our registrar", ours: "Our registrar", support: "our registrar's support" };
}
