import { randomInt } from "node:crypto";

const UP = "ABCDEFGHJKLMNPQRSTUVWXYZ", LOW = "abcdefghijkmnopqrstuvwxyz", DIG = "23456789";
/**
 * A fresh random transfer authorization code: 20 characters with upper, lower and digit classes.
 * UNVERIFIED: OpenSRS does not document the accepted format for `domain_auth_info` on our six extensions (the 16 to 48 character mixed-class
 * rule in the dossier is for CentralNic TLDs). Confirm in Horizon before launch.
 */
export function randomAuthCode(length = 20): string {
  const all = UP + LOW + DIG;
  const chars = [UP[randomInt(UP.length)]!, LOW[randomInt(LOW.length)]!, DIG[randomInt(DIG.length)]!];
  while (chars.length < length) chars.push(all[randomInt(all.length)]!);
  for (let i = chars.length - 1; i > 0; i--) { const j = randomInt(i + 1); [chars[i], chars[j]] = [chars[j]!, chars[i]!]; }
  return chars.join("");
}
