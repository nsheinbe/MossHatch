/**
 * Registrant phone numbers. The registrar port, the registries and ICANN's contact data want the EPP form `+CC.NNNNNNN`
 * (RFC 5733 section 2.5: `+`, the country calling code, a dot, then the national number without its trunk prefix), which nobody
 * types. This reads what people do type and writes that form: `(310) 555-0100` with country US, `+44 (0)20 7946 0958`,
 * `0049 30 1234567`, `011 44 20 7946 0958` from a North American form, `310-555-0100 ext. 12`, or the EPP form itself.
 * Null when it cannot be read; the server answers 422 `invalid_contact` for those, and the forms say what works.
 */

/** ITU-T E.164 country calling codes by ISO 3166-1 alpha-2 code. The North American Numbering Plan members all share 1. */
export const CALLING_CODES: Readonly<Record<string, string>> = {
  AF: "93", AX: "358", AL: "355", DZ: "213", AS: "1", AD: "376", AO: "244", AI: "1", AQ: "672", AG: "1", AR: "54", AM: "374", AW: "297",
  AU: "61", AT: "43", AZ: "994", BS: "1", BH: "973", BD: "880", BB: "1", BY: "375", BE: "32", BZ: "501", BJ: "229", BM: "1", BT: "975",
  BO: "591", BA: "387", BW: "267", BR: "55", IO: "246", BN: "673", BG: "359", BF: "226", BI: "257", KH: "855", CM: "237", CA: "1",
  CV: "238", KY: "1", CF: "236", TD: "235", CL: "56", CN: "86", CX: "61", CC: "61", CO: "57", KM: "269", CG: "242", CD: "243", CK: "682",
  CR: "506", CI: "225", HR: "385", CU: "53", CW: "599", CY: "357", CZ: "420", DK: "45", DJ: "253", DM: "1", DO: "1", EC: "593", EG: "20",
  SV: "503", GQ: "240", ER: "291", EE: "372", SZ: "268", ET: "251", FK: "500", FO: "298", FJ: "679", FI: "358", FR: "33", GF: "594",
  PF: "689", GA: "241", GM: "220", GE: "995", DE: "49", GH: "233", GI: "350", GR: "30", GL: "299", GD: "1", GP: "590", GU: "1", GT: "502",
  GG: "44", GN: "224", GW: "245", GY: "592", HT: "509", VA: "39", HN: "504", HK: "852", HU: "36", IS: "354", IN: "91", ID: "62", IR: "98",
  IQ: "964", IE: "353", IM: "44", IL: "972", IT: "39", JM: "1", JP: "81", JE: "44", JO: "962", KZ: "7", KE: "254", KI: "686", KP: "850",
  KR: "82", XK: "383", KW: "965", KG: "996", LA: "856", LV: "371", LB: "961", LS: "266", LR: "231", LY: "218", LI: "423", LT: "370",
  LU: "352", MO: "853", MG: "261", MW: "265", MY: "60", MV: "960", ML: "223", MT: "356", MH: "692", MQ: "596", MR: "222", MU: "230",
  YT: "262", MX: "52", FM: "691", MD: "373", MC: "377", MN: "976", ME: "382", MS: "1", MA: "212", MZ: "258", MM: "95", NA: "264",
  NR: "674", NP: "977", NL: "31", NC: "687", NZ: "64", NI: "505", NE: "227", NG: "234", NU: "683", NF: "672", MK: "389", MP: "1", NO: "47",
  OM: "968", PK: "92", PW: "680", PS: "970", PA: "507", PG: "675", PY: "595", PE: "51", PH: "63", PN: "64", PL: "48", PT: "351", PR: "1",
  QA: "974", RE: "262", RO: "40", RU: "7", RW: "250", BL: "590", SH: "290", KN: "1", LC: "1", MF: "590", PM: "508", VC: "1", WS: "685",
  SM: "378", ST: "239", SA: "966", SN: "221", RS: "381", SC: "248", SL: "232", SG: "65", SX: "1", SK: "421", SI: "386", SB: "677",
  SO: "252", ZA: "27", GS: "500", SS: "211", ES: "34", LK: "94", SD: "249", SR: "597", SJ: "47", SE: "46", CH: "41", SY: "963", TW: "886",
  TJ: "992", TZ: "255", TH: "66", TL: "670", TG: "228", TK: "690", TO: "676", TT: "1", TN: "216", TR: "90", TM: "993", TC: "1", TV: "688",
  UG: "256", UA: "380", AE: "971", GB: "44", US: "1", UY: "598", UZ: "998", VU: "678", VE: "58", VN: "84", VG: "1", VI: "1", WF: "681",
  EH: "212", YE: "967", ZM: "260", ZW: "263",
};

const CODES = new Set(Object.values(CALLING_CODES));
/** Italy and the Vatican keep the leading 0 of a landline in international form; everywhere else a leading 0 is the trunk prefix. */
const KEEP_LEADING_ZERO = new Set(["39"]);
/** The EPP form (RFC 5733): `+CC.number`, 1 to 3 digits of country code, 4 to 14 digits of number. */
export const EPP_PHONE = /^\+\d{1,3}\.\d{4,14}$/;
const EXTENSION = /\s*(?:x|ext\.?|extension|#)\s*\d{1,6}\s*$/i;

/**
 * The EPP form of a typed phone number, or null when it cannot be read. `country` is the contact's ISO 3166-1 alpha-2 country,
 * used for a number written without a country code; a number that starts with `+`, `00` or (from a NANP country) `011` names its
 * own. An extension at the end (`ext. 12`, `x12`) is dropped: it is not part of the number.
 */
export function normalizePhone(raw: string, country?: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (EPP_PHONE.test(s)) return s;
  const own = CALLING_CODES[(country ?? "").trim().toUpperCase()];
  const main = s.replace(EXTENSION, "");
  const all = main.replace(/\D/g, "");
  if (!all) return null;

  let international = false;
  let digits = all;
  if (main.startsWith("+")) international = true;
  else if (/^00\d/.test(all) && !main.startsWith("(")) { international = true; digits = all.slice(2); }
  else if (own === "1" && /^011\d/.test(all) && all.length > 11) { international = true; digits = all.slice(3); }

  if (international) {
    // E.164 codes are prefix-free, so the longest known prefix is the only reading.
    const cc = [3, 2, 1].map((n) => digits.slice(0, n)).find((c) => CODES.has(c));
    if (!cc) return null;
    let rest = digits.slice(cc.length);
    if (!KEEP_LEADING_ZERO.has(cc)) rest = rest.replace(/^0+(?=\d)/, "");   // "+44 (0)20 ..." carries the trunk 0 people write in brackets
    return finish(cc, rest);
  }
  if (!own) return null;
  let rest = digits;
  if (own === "1") {
    if (rest.length === 11 && rest.startsWith("1")) rest = rest.slice(1);
  } else if (own === "7" && rest.length === 11 && rest.startsWith("8")) {
    rest = rest.slice(1);                                                    // Russia and Kazakhstan dial 8 at home for +7
  } else if (!KEEP_LEADING_ZERO.has(own)) {
    rest = rest.replace(/^0+(?=\d)/, "");
  }
  return finish(own, rest);
}

function finish(cc: string, rest: string): string | null {
  if (cc === "1" && rest.length !== 10) return null;                        // every NANP number has ten digits
  const out = `+${cc}.${rest}`;
  return EPP_PHONE.test(out) ? out : null;
}
