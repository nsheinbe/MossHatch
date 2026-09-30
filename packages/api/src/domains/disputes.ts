import { tx } from "@mosshatch/db";
import type { AppContext } from "../ports.ts";
import { appendAudit } from "../audit.ts";
import { raiseAlert } from "../ops/alerts.ts";
import { loadDomain } from "./common.ts";

/**
 * Disputes (ST-102, C-23).
 *
 * Payment disputes: `charge.dispute.created` and `radar.early_fraud_warning.created` already set `users.risk_state = 'review'` in the Stripe
 * webhook (orders module). From here on that flag pauses renewal charges (renewals.ts `chargeHold`: "account_review") and holds new orders above
 * USD 50 wholesale (compliance velocity); a person looks, and `clearAccountReview` puts the account back. A payment dispute never blocks
 * unlock or code release (Transfer Policy I.A.5.4), so nothing here touches the lock. The refund cap of 3 per account per 30 days lives in
 * the machine's `requestRefund`.
 *
 * UDRP and URS dispute locks (`domains.dispute_lock_state`, C-23) are set and cleared by the domain-management module's `dispute.ts`; this module only
 * reads the column, to show needs-attention (state.ts). Renewals continue while a dispute lock is on.
 */
/** A person has looked at the dispute evidence and the account returns to normal; held renewal charges resume on the next scheduler pass. */
export async function clearAccountReview(ctx: AppContext, userId: string, operator: string): Promise<boolean> {
  return tx(ctx.cron, async (c) => {
    const r = await c.query("update users set risk_state = 'normal' where id = $1 and risk_state = 'review'", [userId]);
    if (r.rowCount !== 1) return false;
    await appendAudit(ctx, c, { chainId: userId, actorKind: "support", action: "account.review_cleared", resourceKind: "user", resourceId: userId, detail: { operator_ref: operator.slice(0, 40) } });
    return true;
  });
}
