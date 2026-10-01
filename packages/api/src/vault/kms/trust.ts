/**
 * The IAM trust policy for the vault roles (PLAN 4.3b Secrets: OIDC federation pinned to the Team issuer, to the `sub` of
 * project `web` in production and to a random 32-byte custom audience) and a small evaluator of its StringEquals
 * conditions. The evaluator is what ST-07 runs in this repository; the policy document is what the operator applies.
 * Not verified against IAM: that needs the staging account.
 */

export interface OidcTrustConfig {
  /** `oidc.vercel.com/<team-slug>` (issuer URL without the scheme). */
  issuerHost: string;
  team: string;
  project: string;
  environment: "production";
  /** Random 32 bytes, base64url; the IAM provider's only audience. */
  audience: string;
  providerArn: string;
  maxSessionSeconds?: number;
}

export function vaultTrustPolicy(cfg: OidcTrustConfig) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(cfg.audience)) throw new Error("trust: the audience must be 32 random bytes in base64url");
  return {
    Version: "2012-10-17",
    Statement: [{
      Effect: "Allow",
      Principal: { Federated: cfg.providerArn },
      Action: "sts:AssumeRoleWithWebIdentity",
      Condition: {
        StringEquals: {
          [`${cfg.issuerHost}:aud`]: cfg.audience,
          [`${cfg.issuerHost}:sub`]: `owner:${cfg.team}:project:${cfg.project}:environment:${cfg.environment}`,
        },
      },
    }],
  };
}

export interface WebIdentityRequest { iss: string; aud: string; sub: string; durationSeconds: number }

/** Would STS let this token assume the role? Every StringEquals must hold, the issuer must be the provider's, and the session is capped. */
export function trustAllows(policy: ReturnType<typeof vaultTrustPolicy>, cfg: OidcTrustConfig, req: WebIdentityRequest): boolean {
  if (req.iss !== `https://${cfg.issuerHost}`) return false;
  if (req.durationSeconds > (cfg.maxSessionSeconds ?? 3600) || req.durationSeconds < 900) return false;
  for (const st of policy.Statement) {
    if (st.Effect !== "Allow" || st.Action !== "sts:AssumeRoleWithWebIdentity") continue;
    const conds = st.Condition.StringEquals as Record<string, string>;
    const ok = Object.entries(conds).every(([k, v]) => {
      const claim = k.slice(k.lastIndexOf(":") + 1) as "aud" | "sub";
      return req[claim] === v;
    });
    if (ok) return true;
  }
  return false;
}
