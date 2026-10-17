import type { AppContext } from "../ports.ts";

/** A flag is on only when its jsonb value is exactly `true`. Missing is off. */
export async function flagOn(ctx: AppContext, name: string): Promise<boolean> {
  const r = await ctx.runtime.query("select value from flags where name = $1", [name]);
  return r.rows[0]?.value === true;
}
