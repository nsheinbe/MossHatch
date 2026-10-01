import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { formatUsd, usd, feePerYear } from "@mosshatch/core";
import { EXTENSIONS, SAMPLE_WHOLESALE_CENTS } from "@mosshatch/registrar";
import { siteMode, transformHome } from "../../scripts/site-mode.mjs";

const root = fileURLToPath(new URL(".", import.meta.url));

/** The price list in the static HTML is generated at build time from the adapter's sample quotes. */
function staticPrices(): Plugin {
  return {
    name: "mosshatch-static-prices",
    transformIndexHtml(html) {
      const items = EXTENSIONS.map((tld) => {
        const w = SAMPLE_WHOLESALE_CENTS[tld]!;
        const years = tld === "ai" ? 2 : 1;
        const price = formatUsd(usd((w + feePerYear(usd(w)).cents) * years));
        return `<li><span class="ext">.${tld}</span> <span class="price">${price}</span> <span class="note">${years === 2 ? "for 2 years" : "first year"}, renews the same</span></li>`;
      }).join("");
      const asOf = new Date().toISOString().slice(0, 10);
      return html
        .replace("<!--PRICES-->", items)
        .replace("<!--ASOF-->", asOf);
    },
  };
}

/** Demo or live (scripts/site-mode.mjs): the title, description, canonical URL and share tags, and in demo mode the preview banner. */
function siteMeta(): Plugin {
  return { name: "mosshatch-site-meta", transformIndexHtml: (html, ctx) => (ctx.path === "/debug.html" ? html : transformHome(html, siteMode(process.env))) };
}

/** Strip comments and indentation from GLSL imported with ?raw (keeps line breaks for #directives). */
function glslMinify(): Plugin {
  return {
    name: "mosshatch-glsl-minify",
    enforce: "pre",
    transform(code, id) {
      if (!/\.(glsl|vert|frag)\?raw$/.test(id)) return null;
      const m = /^export default (".*")\s*;?\s*$/s.exec(code);
      if (!m) return null;
      const src: string = JSON.parse(m[1]!);
      const out = src.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((l) => l.replace(/\/\/.*$/, "").trim()).filter(Boolean).join("\n");
      return { code: `export default ${JSON.stringify(out)};`, map: null };
    },
  };
}

/**
 * Dev-server API for local end-to-end runs (MH_DEV_API=1): boots the real router against a local PostgreSQL with a fake Stripe and a
 * recording mailbox, and adds two /__dev routes (last mail, fake checkout). Never part of a build.
 */
function devApi(): Plugin {
  return {
    name: "mosshatch-dev-api",
    apply: "serve",
    configureServer(server) {
      if (process.env.MH_DEV_API !== "1") return;
      let booted: Promise<{ router: any; ctx: any; email: any; stripe: any; secret: string }> | undefined;
      const boot = () => (booted ??= (async () => {
        const mod: any = await server.ssrLoadModule(root + "../../packages/api/src/boot.ts");
        const { FakeEmail } = (await server.ssrLoadModule(root + "../../packages/api/src/email.ts")) as any;
        const b = await mod.bootFromEnv({ ...process.env, MH_MODE: "local", MH_FAKE_STRIPE: "1" });
        const email = new FakeEmail();
        b.ctx.email = email;
        const stripe = b.ctx.services.orders.stripe;
        return { ...b, email, stripe, secret: (process.env.STRIPE_WEBHOOK_SECRET ?? "whsec_dev_local_0123456789abcdef") };
      })());
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? "";
        if (!url.startsWith("/api/") && !url.startsWith("/__dev/")) return next();
        try {
          const app = await boot();
          const origin = process.env.MH_ORIGIN ?? "http://localhost:5173";
          if (url.startsWith("/__dev/mail")) {
            const to = new URL(url, origin).searchParams.get("to") ?? "";
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify(app.email.to(to).map((m: any) => ({ kind: m.kind, text: m.text }))));
          }
          if (url.startsWith("/__dev/invite")) {
            // The owner's invite script (scripts/waitlist-invite.mjs) for one address: a confirmed waitlist entry, then the real
            // createInvites, which mails the /invite link to the recording mailbox (read it back with /__dev/mail).
            const to = (new URL(url, origin).searchParams.get("email") ?? "").toLowerCase();
            if (!/^[a-z0-9.+-]+@[a-z0-9.-]+$/.test(to)) { res.statusCode = 400; return res.end("{}"); }
            await app.ctx.cron.query("insert into waitlist (email, consent_hash, consented_at, source, created_at, confirmed_at) values ($1, $2, now(), 'page', now(), now()) on conflict (email) do nothing", [to, Buffer.alloc(32, 1)]);
            const owner: any = await server.ssrLoadModule(root + "../../packages/api/src/waitlist/owner.ts");
            const out = await owner.createInvites(app.ctx.cron, app.email, origin, { email: to });
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify(out));
          }
          if (url.startsWith("/__dev/transfer-away")) {
            // The mock registrar's out-of-band simulator: someone at another registrar starts a transfer of this name. The poll runs at once
            // (in production it runs every 5 minutes) so the page can show "needs attention" and the Stop button.
            const fqdn = (new URL(url, origin).searchParams.get("fqdn") ?? "").toLowerCase();
            const reg: any = app.ctx.services.orders.registrar;
            if (!/^[a-z0-9-]+\.[a-z]+$/.test(fqdn) || !reg.oob) { res.statusCode = 400; return res.end("{}"); }
            reg.oob.startTransferAway(fqdn, { gainingRegistrar: "Other Registrar Inc." });
            const tr: any = await server.ssrLoadModule(root + "../../packages/api/src/domain-mgmt/transfer.ts");
            const out = await tr.transferPoll(app.ctx);
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify(out));
          }
          if (url.startsWith("/__dev/transfer-in")) {
            // The mock registrar's transfer-in simulator. `do=seed` puts a name at "another registrar" with the code its owner holds (the
            // losing registrar then acks). `do=complete` lets the registry's review time pass at once and runs the poll that production
            // runs every 5 minutes, then the job ticks, so the server itself records the outcome it reads from the adapter.
            const q = new URL(url, origin).searchParams;
            const fqdn = (q.get("fqdn") ?? "").toLowerCase();
            const reg: any = app.ctx.services.orders.registrar;
            if (!/^[a-z0-9-]+\.[a-z]+$/.test(fqdn) || !reg.transferIn) { res.statusCode = 400; return res.end("{}"); }
            if (q.get("do") === "seed") reg.transferIn.seedForeign(fqdn, { authCode: q.get("code") ?? "", losing: "ack" });
            else {
              for (const t of reg.transferIn.list()) if (t.fqdn === fqdn && t.status === "pending_registry" && !t.registrySentAt) t.reviewAt = new Date(Date.now() - 1000);
              await app.ctx.cron.query("update transfers_in set next_check_at = null where fqdn_ascii = $1", [fqdn]);
              const tj: any = await server.ssrLoadModule(root + "../../packages/api/src/transfers/jobs.ts");
              await tj.pollTransfersIn(app.ctx);
              const eng: any = await server.ssrLoadModule(root + "../../packages/api/src/jobs/engine.ts");
              for (let i = 0; i < 6; i++) { const r = await eng.runTick(app.ctx, { heartbeat: false, budgetMs: 5000 }); if (r.claimed === 0) break; }
            }
            const row = (await app.ctx.cron.query("select state from transfers_in where fqdn_ascii = $1 order by created_at desc limit 1", [fqdn])).rows[0];
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ state: row?.state ?? null }));
          }
          if (url.startsWith("/__dev/pay")) {
            // Pay the fake Checkout, deliver the signed webhooks, run the jobs, and send the person back to the app.
            const q = new URL(url, origin).searchParams;
            const order = q.get("order") ?? "";
            const row = (await app.ctx.cron.query("select stripe_checkout_session_id from orders where id = $1", [order])).rows[0];
            const sessionId: string = row.stripe_checkout_session_id;
            const events = app.stripe.payCheckout(row.stripe_checkout_session_id, {});
            for (const ev of events) {
              const w = app.stripe.deliver(ev, [app.secret], {});
              await app.router.dispatch(app.ctx, new Request(origin + "/api/v1/webhooks/stripe", { method: "POST", body: w.body, headers: { "stripe-signature": w.headers["stripe-signature"], "content-type": "application/json" } }));
            }
            const eng: any = await server.ssrLoadModule(root + "../../packages/api/src/jobs/engine.ts");
            for (let i = 0; i < 6; i++) { const r = await eng.runTick(app.ctx, { heartbeat: false, budgetMs: 5000 }); if (r.claimed === 0) break; }
            res.statusCode = 302; res.setHeader("location", `/checkout/return?order=${order}&session_id=${sessionId}`); return res.end();
          }
          const chunks: Buffer[] = [];
          for await (const c of req) chunks.push(c as Buffer);
          const headers = new Headers();
          for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v); else if (Array.isArray(v)) for (const x of v) headers.append(k, x);
          const body = chunks.length && req.method !== "GET" && req.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
          const out: Response = await app.router.dispatch(app.ctx, new Request(origin + url, { method: req.method, headers, body }));
          res.statusCode = out.status;
          out.headers.forEach((v, k) => { if (k !== "set-cookie") res.setHeader(k, v); });
          const sc = out.headers.getSetCookie();
          if (sc.length) res.setHeader("set-cookie", sc);
          res.end(Buffer.from(await out.arrayBuffer()));
        } catch (e) {
          res.statusCode = 503; res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({ error: { code: "not_configured", reason: (e as Error).name } }));
        }
      });
    },
  };
}

/**
 * Dev-server /api/lookup (the preview's registered-or-not check, packages/api/src/lookup), as api/index.ts serves it in production.
 * MH_FAKE_LOOKUP=1 answers from a deterministic fake of the registries instead of the network (the Playwright dev project). Never
 * part of a build. With MH_DEV_API=1 the page is in live mode and searches through the registrar port instead.
 */
function devLookup(): Plugin {
  return {
    name: "mosshatch-dev-lookup",
    apply: "serve",
    configureServer(server) {
      let handler: ((r: Request) => Promise<Response | null>) | undefined;
      server.middlewares.use(async (req, res, next) => {
        if (!(req.url ?? "").startsWith("/api/lookup")) return next();
        try {
          if (!handler) {
            const mod: any = await server.ssrLoadModule(root + "../../packages/api/src/lookup/index.ts");
            handler = mod.createLookup(process.env.MH_FAKE_LOOKUP === "1" ? { fetch: mod.fakeRdapFetch, perMinute: 10_000, perHour: 100_000 } : {});
          }
          const out = await handler!(new Request("http://localhost" + req.url, { method: req.method, headers: { "x-forwarded-for": req.socket.remoteAddress ?? "" } }));
          if (!out) return next();
          res.statusCode = out.status;
          out.headers.forEach((v, k) => res.setHeader(k, v));
          res.end(Buffer.from(await out.arrayBuffer()));
        } catch { res.statusCode = 500; res.end(); }
      });
    },
  };
}

// The debug entry (?debug=states via /debug.html) is a review tool. It is only part of a build when asked for.
const withDebug = process.env.MOSSHATCH_DEBUG_ENTRY === "1";

export default defineConfig({
  plugins: [glslMinify(), react(), staticPrices(), siteMeta(), devLookup(), devApi()],
  build: {
    target: "es2022",
    modulePreload: { polyfill: false },
    sourcemap: false,
    rollupOptions: {
      input: { main: root + "index.html", ...(withDebug ? { debug: root + "debug.html" } : {}) },
    },
  },
  define: { __DEBUG_ENTRY__: JSON.stringify(withDebug) },
});
