import { connect } from "@mosshatch/db";
import type { AppContext, Mode } from "../ports.ts";
import { LocalVaultKms } from "./kms/local.ts";
import { installVault } from "./context.ts";
import { registerVaultJobs } from "./jobs.ts";

/**
 * Boot wiring. The vault needs its own database login (a member of `mh_vault`) in `DATABASE_URL_VAULT`; local mode falls
 * back to `DATABASE_URL`. Production needs the AWS adapter (`AwsVaultKms`) with OIDC-federated credentials, which is not
 * wired: without it the vault routes answer 503 `vault_unavailable` (fail closed), never a local key.
 */
export function installVaultFromEnv(ctx: AppContext, env: Record<string, string | undefined>, mode: Mode): void {
  registerVaultJobs();
  if (mode === "production" || mode === "staging") return;
  const url = env.DATABASE_URL_VAULT ?? (mode === "local" ? env.DATABASE_URL : undefined);
  const root = env.MH_LOCAL_KMS_ROOT;
  if (!url || (mode !== "local" && (!root || root.length < 32))) return;
  installVault(ctx, { pool: connect(url, { max: 5 }), kms: new LocalVaultKms({ root: Buffer.from(root ?? "mosshatch-local-vault-root-not-secret"), clock: ctx.clock }) });
}
