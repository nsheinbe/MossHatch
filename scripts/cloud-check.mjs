// Read-only project workspace checks. Reports variable NAMES, never values or connection URLs.
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';

let failures = 0;
const report = (ok, label) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8' });
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const lock = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
report(pkg.name === 'mosshatch' && lock.name === 'mosshatch', 'MossHatch workspace and npm lockfile');
const origin = run('git', ['remote', 'get-url', 'origin']);
report(origin.status === 0 && /github\.com[:/]nsheinbe\/MossHatch(?:\.git)?\s*$/.test(origin.stdout), 'expected repository origin (URL withheld)');
const branch = run('git', ['branch', '--show-current']);
report(branch.status === 0 && /^codex\//.test(branch.stdout.trim()), 'isolated codex feature branch');
console.log(`Node ${process.version}; npm ${run('npm', ['--version']).stdout.trim()}`);
report(Number(process.versions.node.split('.')[0]) >= 22, 'Node satisfies repository >=22 engine');
report(/^ignore-scripts=true$/m.test(fs.readFileSync('.npmrc', 'utf8')), 'install lifecycle scripts disabled');
for (const name of ['typecheck', 'test', 'build', 'build:cards', 'test:e2e', 'check:st']) report(Boolean(pkg.scripts[name]), `repository command: ${name}`);
console.log('No lint command is defined; supply-chain, security-ID, TypeScript, tests and build checks are required.');
const relevant = Object.keys(process.env).filter(k => /^(DATABASE_URL|TEST_DATABASE_URL|OPENPROVIDER_|STRIPE_|AWS_|REGISTRAR_RPC|RESEND_|MH_|VITE_|PLAYWRIGHT_)/.test(k)).sort();
console.log(`Present environment variable names only: ${relevant.join(', ') || '(none)'}`);
const url = process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:54329/postgres';
let local = false;
try { const u = new URL(url); local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && ['postgres:', 'postgresql:'].includes(u.protocol); } catch { /* fail below without printing URL */ }
report(local, 'TEST_DATABASE_URL is loopback (remote databases are never probed)');
if (local) {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 3000 });
  try { await client.connect(); const r = await client.query('show server_version_num'); report(Number(r.rows[0].server_version_num) >= 160000, 'local PostgreSQL 16+ connection'); }
  catch { report(false, 'local PostgreSQL connection unavailable; run sh scripts/cloud-test-db.sh start'); }
  finally { await client.end().catch(() => {}); }
}
const { chromium } = await import('@playwright/test');
try {
  const browser = await chromium.launch({ headless: true, ...(process.env.MH_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.MH_CHROMIUM_EXECUTABLE_PATH } : {}) });
  console.log(`Browser version: ${browser.version()}`);
  const page = await browser.newPage(); await page.setContent('<title>MossHatch local check</title>');
  report(await page.title() === 'MossHatch local check', 'local Chromium page launch');
  await browser.close();
} catch { report(false, 'Chromium launch failed; install the pinned browser or explicitly set MH_CHROMIUM_EXECUTABLE_PATH'); }
report(fs.existsSync('apps/web/public/fonts/young-serif-latin-400-normal.woff2'), 'committed fonts available (regeneration optional)');
const pgBin = process.env.MH_PG_BIN ?? '/usr/lib/postgresql/16/bin';
for (const tool of ['pg_dump', 'pg_restore']) report(run(`${pgBin}/${tool}`, ['--version']).status === 0, `${tool} available for synthetic restore tests`);
console.log('No production services, saved environment template, credentials, or grants were changed.');
process.exitCode = failures ? 1 : 0;
