// The bundle is built by `npm run build` (scripts/build-api.mjs) before Vercel packages the function.
import { bootFromEnv, NotConfigured } from "./_bundle.mjs";

type Boot = Awaited<ReturnType<typeof bootFromEnv>>;

/**
 * One Vercel function for every /api route. Until DATABASE_URL and the adapters are configured for the deployment it answers 503
 * with a reason code, so a preview without a database is honest instead of broken.
 */
let booted: Promise<Boot | { error: string }> | undefined;
function boot(): Promise<Boot | { error: string }> {
  booted ??= bootFromEnv(process.env).catch((e) => ({ error: e instanceof NotConfigured ? e.reason : (e as Error).name }));
  return booted;
}

export default {
  async fetch(request: Request): Promise<Response> {
    const b = await boot();
    if ("error" in b) {
      return new Response(JSON.stringify({ error: { code: "not_configured", reason: b.error } }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return b.router.dispatch(b.ctx, request);
  },
};
