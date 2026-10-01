#!/usr/bin/env node
import { runCli } from "./cli.ts";
import { defaultStore } from "./store.ts";

/** The published entry point: real fetch, real keychain or file, the real process streams. */
const env = { ...process.env };
const store = await defaultStore(env);
const code = await runCli(process.argv.slice(2), {
  fetch: (url, init) => fetch(url, init),
  store,
  env,
  stdout: process.stdout,
  stderr: process.stderr,
  stdoutIsTTY: !!process.stdout.isTTY,
  stdinIsTTY: !!process.stdin.isTTY,
  readStdin: async () => { const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c as Buffer); return Buffer.concat(chunks).toString("utf8"); },
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
});
process.exitCode = code;
