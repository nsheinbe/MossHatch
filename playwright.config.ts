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
    { command: "npm run dev -w @mosshatch/web -- --port 5173 --host 127.0.0.1", url: "http://127.0.0.1:5173/", reuseExistingServer: true },
    { command: "node scripts/e2e-server.mjs", url: "http://localhost:5174/", reuseExistingServer: true, timeout: 120_000 },
  ],
  projects: [
    { name: "prod", testMatch: /prod\.spec\.ts/, use: { baseURL: "http://127.0.0.1:4173", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
    { name: "dev", testMatch: /dev\.spec\.ts/, use: { baseURL: "http://127.0.0.1:5173", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
    { name: "account", testMatch: /account\.spec\.ts/, use: { baseURL: "http://localhost:5174", launchOptions: { args: gl }, viewport: { width: 1280, height: 720 } } },
  ],
});
