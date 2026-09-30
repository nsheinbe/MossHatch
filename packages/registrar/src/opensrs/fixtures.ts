import { opsReply } from "./fake-horizon.ts";

/**
 * Hand-written response fixtures. source: "documented" means written from the response shapes and codes in docs/research/reg-opensrs.md
 * (S11 codes, S12 lookup, S15 sw_register `forced_pending`, S16 renew). None was recorded from Horizon or the live API; no real response has been seen.
 */
export interface Fixture { name: string; source: "documented"; xml: string }
export const DOCUMENTED_FIXTURES: Fixture[] = [
  { name: "lookup taken (211, is_success=1)", source: "documented", xml: opsReply(211, { status: "taken" }) },
  { name: "lookup available (210)", source: "documented", xml: opsReply(210, { status: "available" }) },
  { name: "register forced_pending", source: "documented", xml: opsReply(200, { id: "1001", forced_pending: "1" }) },
  { name: "register accepted async (250)", source: "documented", xml: opsReply(250, { id: "1002" }) },
  { name: "insufficient funds (440)", source: "documented", xml: opsReply(440, {}) },
  { name: "entity already in a processing state (486)", source: "documented", xml: opsReply(486, {}) },
  { name: "rate limited (300)", source: "documented", xml: opsReply(300, {}) },
  { name: "timed out, resubmit (705)", source: "documented", xml: opsReply(705, {}) },
  { name: "already renewed (555)", source: "documented", xml: opsReply(555, {}) },
  { name: "domain taken (485)", source: "documented", xml: opsReply(485, {}) },
];
