import { describe, expect, it } from "vitest";
import type { AppContext, Mode } from "../ports.ts";
import { installVaultFromEnv } from "./wiring.ts";
import { vaultOf } from "./context.ts";

const bareCtx = () => ({ services: {}, clock: { now: () => new Date() } }) as unknown as AppContext;
const installed = (ctx: AppContext) => (ctx.services as { vault?: { pool: { end(): Promise<void> } } }).vault;

describe("boot wiring", () => {
  it("review: preview (and every mode but local) never installs the local vault, whatever the environment holds", async () => {
    const env = { DATABASE_URL: "postgres://nobody@127.0.0.1:1/none", DATABASE_URL_VAULT: "postgres://nobody@127.0.0.1:1/none", MH_LOCAL_KMS_ROOT: "r".repeat(48) };
    for (const mode of ["preview", "staging", "production"] as Mode[]) {
      const ctx = bareCtx();
      installVaultFromEnv(ctx, env, mode);
      const v = installed(ctx);
      await v?.pool.end();
      expect(v, mode).toBeUndefined();
      expect(() => vaultOf(ctx), mode).toThrow(expect.objectContaining({ status: 503, code: "vault_unavailable" }));
    }
    // Local development still gets the local fake.
    const local = bareCtx();
    installVaultFromEnv(local, { DATABASE_URL: env.DATABASE_URL }, "local");
    const v = installed(local);
    expect(v).toBeDefined();
    await v?.pool.end();
  });
});
