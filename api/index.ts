// The bundle is built by `npm run build` (scripts/build-api.mjs) before Vercel packages the function.
import { bootFromEnv, NotConfigured, handleWaitlist, handleLookup } from "./_bundle.mjs";

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
    // The waitlist needs only DATABASE_URL (and optionally RESEND_API_KEY), so it answers even while the full API refuses to boot.
    const w = await handleWaitlist(request, process.env);
    if (w) return w;
    // The preview's registered-or-not check (public RDAP, no database) answers the same way.
    const l = await handleLookup(request, process.env);
    if (l) return l;
    const b = await boot();
    if ("error" in b) {
      return new Response(JSON.stringify({ error: { code: "not_configured", reason: b.error } }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
    }
    return b.router.dispatch(b.ctx, request);
  },
};
