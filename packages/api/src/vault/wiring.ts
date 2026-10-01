import { connect } from "@mosshatch/db";
import type { AppContext, Mode } from "../ports.ts";
import { LocalVaultKms } from "./kms/local.ts";
import { installVault } from "./context.ts";
import { registerVaultJobs } from "./jobs.ts";

/**
 * Boot wiring. The vault needs its own database login (a member of `mh_vault`) in `DATABASE_URL_VAULT`; local mode falls
 * back to `DATABASE_URL`. Only local mode gets the local fake KMS. Preview has the vault off by plan (4.3a: Nest routes
 * return 503), whatever its environment holds. Staging and production need the AWS adapter (`AwsVaultKms`) with
 * OIDC-federated credentials, which is not wired: without it the vault routes answer 503 `vault_unavailable` (fail
 * closed), never a local key.
 */
export function installVaultFromEnv(ctx: AppContext, env: Record<string, string | undefined>, mode: Mode): void {
  registerVaultJobs();
  if (mode !== "local") return;
  const url = env.DATABASE_URL_VAULT ?? env.DATABASE_URL;
  if (!url) return;
  installVault(ctx, { pool: connect(url, { max: 5 }), kms: new LocalVaultKms({ root: Buffer.from(env.MH_LOCAL_KMS_ROOT ?? "mosshatch-local-vault-root-not-secret"), clock: ctx.clock }) });
}
