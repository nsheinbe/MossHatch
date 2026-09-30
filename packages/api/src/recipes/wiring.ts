import type { AppContext, Mode } from "../ports.ts";
import { httpsProbe, installRecipeProviders, neonAdapter, resendAdapter, vercelAdapter } from "./providers.ts";
import { makeFakes } from "./fakes.ts";

/**
 * Boot wiring for recipe providers. Staging and production use the fetch adapters (reached only by the `recipe.apply` and
 * `connection.check` jobs, with the customer's own least-scope credential). Local and preview use the fakes, so a
 * development machine never calls Vercel, Neon or Resend.
 */
export function installRecipesFromEnv(ctx: AppContext, mode: Mode): void {
  if (mode === "production" || mode === "staging") installRecipeProviders(ctx, { vercel: vercelAdapter(), neon: neonAdapter(), resend: resendAdapter(), probe: httpsProbe() });
  else installRecipeProviders(ctx, makeFakes());
}
