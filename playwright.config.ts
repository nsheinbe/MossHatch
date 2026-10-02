import { defineConfig } from "@playwright/test";

const gl = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"];
export default defineConfig({
  testDir: "e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 90_000,
  workers: 1,
  reporter: [["list"]],
  webServer: [
    { command: "node e2e/serve-dist.mjs 4173", url: "http://127.0.0.1:4173/", reuseExistingServer: true },
    { command: "npm run dev -w @mosshatch/web -- --port 5173 --host 127.0.0.1", url: "http://127.0.0.1:5173/", reuseExistingServer: true, env: { MH_FAKE_LOOKUP: "1" } },
    { command: "node scripts/e2e-server.mjs", url: "http://localhost:5174/", reuseExistingServer: true, timeout: 120_000 },
    { command: "node e2e/serve-cards.mjs 4175", url: "http://127.0.0.1:4175/", reuseExistingServer: true },
    // The invite-only live build (docs/GO-LIVE.md): one build, demo for visitors and the shop for invited accounts.
    { command: "node scripts/e2e-server.mjs", url: "http://localhost:5176/", reuseExistingServer: true, timeout: 120_000,
      env: { E2E_PORT: "5176", VITE_SITE_MODE: "invite", MH_INVITE_ONLY: "1", MH_LIVE_GATE: "1", MH_FAKE_LOOKUP: "1" } },
  ],
  projects: [
    { name: "prod", testMatch: /prod\.spec\.ts/, use: { baseURL: "http://127.0.0.1:4173", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
    { name: "dev", testMatch: /dev\.spec\.ts/, use: { baseURL: "http://127.0.0.1:5173", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
    { name: "cards", testMatch: /cards\.spec\.ts/, use: { baseURL: "http://127.0.0.1:4175", viewport: { width: 1280, height: 720 } } },
    { name: "public", testMatch: /public\.spec\.ts/, use: { baseURL: "http://127.0.0.1:4173", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
    { name: "publish", testMatch: /publish\.spec\.ts/, use: { baseURL: "http://localhost:5174", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
    { name: "invite", testMatch: /invite\.spec\.ts/, use: { baseURL: "http://localhost:5176", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
    // The brand launcher with its fakes (MH_FAKE_LAUNCHER=1 in scripts/e2e-server.mjs): no model or Slate call from tests.
    { name: "launcher", testMatch: /launcher\.spec\.ts/, use: { baseURL: "http://localhost:5174", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
    { name: "account", testMatch: /account\.spec\.ts/, use: { baseURL: "http://localhost:5174", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
  ],
});
