// Starts the Vite dev server with the real API router on a fresh local database (fake Stripe, recording mailbox).
// Used by the Playwright "account" project. Requires the local PostgreSQL (scripts/pg-local.sh start).
import path from "node:path";
import { createTestDb } from "../packages/db/src/testing.ts";
import { syncDocuments } from "../packages/api/src/account/documents.ts";

const port = Number(process.env.E2E_PORT ?? 5174);
const db = await createTestDb();
await syncDocuments(db.owner, path.resolve("apps/web/public/legal"));
Object.assign(process.env, {
  MH_DEV_API: "1", VITE_API_ENABLED: "1", MH_MODE: "local", MH_ORIGIN: `http://localhost:${port}`, MH_RP_ID: "localhost", MH_ALLOWED_ORIGINS: `http://localhost:${port}`,
  CRON_SECRET: "e2e-cron-secret-0123456789abcdef0123456789",
  DATABASE_URL: db.urlFor("runtime"), DATABASE_URL_CRON: db.urlFor("cron"),
});
const { createServer } = await import("vite");
const server = await createServer({ root: path.resolve("apps/web"), server: { port, host: "localhost", strictPort: true } });
await server.listen();
console.log(`e2e server on http://localhost:${port}`);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await server.close(); await db.drop().catch(() => undefined); process.exit(0); });
