export { lookupUserByEmail, getAccountSummary, listAccountOrders, listAccountDomainStates } from "./read.ts";
export { startLostPasskeyRecovery } from "./actions.ts";
export type { AccountSummary, OrderMeta, DomainMeta } from "./read.ts";
export type { SupportActor, SupportCtx, RecoveryStarter } from "./types.ts";
export { SupportError } from "./types.ts";

/** The complete set of support operations: four reads and one action. Adding one is a reviewed change to this list and to ST-144. */
export const SUPPORT_OPERATIONS = ["lookupUserByEmail", "getAccountSummary", "listAccountOrders", "listAccountDomainStates", "startLostPasskeyRecovery"] as const;
