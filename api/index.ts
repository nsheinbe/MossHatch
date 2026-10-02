// The bundle is built by `npm run build` (scripts/build-api.mjs) before Vercel packages the function.
import { bootFromEnv, NotConfigured, handleWaitlist, handleLookup, runWithOidcToken } from "./_bundle.mjs";

type Boot = Awaited<ReturnType<typeof bootFromEnv>>;

/**
 * One Vercel function for every /api route. Until DATABASE_URL and the adapters are configured for the deployment it answers 503
 * with reason codes, so a preview without a database is honest instead of broken. A failed boot is retried after a minute
 * (a production boot probes AWS live, and a transient failure must not stick for the life of the instance).
 */
const RETRY_FAILED_BOOT_MS = 60_000;
let booted: Promise<Boot | { error: string }> | undefined;
function boot(): Promise<Boot | { error: string }> {
  booted ??= bootFromEnv(process.env).catch((e) => {
    setTimeout(() => { booted = undefined; }, RETRY_FAILED_BOOT_MS).unref?.();
    return { error: e instanceof NotConfigured ? e.reason : (e as Error).name };
  });
  return booted;
}

async function handle(request: Request): Promise<Response> {
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
  return b.router.dispatch(b.ctx, withoutRewriteParam(request));
}

/**
 * Vercel's rewrite ("/api/:path*" -> "/api/index" in vercel.json) adds the captured segment as a `path` query parameter. It carries
 * nothing of the caller's, and routes that refuse unknown parameters (search, quote) would answer 400 unexpected_param, so it is
 * removed before the router sees the request. No route reads a parameter called `path`.
 */
function withoutRewriteParam(request: Request): Request {
  const url = new URL(request.url);
  if (!url.searchParams.has("path")) return request;
  url.searchParams.delete("path");
  const hasBody = request.method !== "GET" && request.method !== "HEAD";
  return new Request(url, { method: request.method, headers: request.headers, body: hasBody ? request.body : undefined, redirect: request.redirect, signal: request.signal, ...(hasBody ? { duplex: "half" } : {}) } as RequestInit);
}

export default {
  async fetch(request: Request): Promise<Response> {
    // The request's Vercel OIDC token is handed to the AWS credential providers only (never logged or forwarded); see packages/api/src/aws/oidc.ts.
    return runWithOidcToken(request.headers.get("x-vercel-oidc-token"), () => handle(request));
  },
};
