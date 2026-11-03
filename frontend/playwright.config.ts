import { defineConfig, devices } from "playwright/test";

const playwrightPort = Number(process.env.PLAYWRIGHT_PORT ?? "3001");
if (!Number.isInteger(playwrightPort) || playwrightPort < 1024 || playwrightPort > 65535) {
  throw new Error("PLAYWRIGHT_PORT must be an integer between 1024 and 65535.");
}
const playwrightUrl = `http://127.0.0.1:${playwrightPort}`;

export default defineConfig({
  testDir: "./e2e",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  retries: 0,
  reporter: "line",
  use: { baseURL: playwrightUrl, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [
    { name: "desktop-chromium", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 1000 } } },
    { name: "mobile-chromium", use: { ...devices["Pixel 5"], browserName: "chromium" } },
  ],
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${playwrightPort}`,
    url: `${playwrightUrl}/`,
    reuseExistingServer: process.env.PLAYWRIGHT_REUSE_EXISTING_SERVER === "true",
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_OPERATOR_PORTAL_ENABLED: "true",
      PLAYWRIGHT_NEXT_DIST_DIR: `.next-playwright-${playwrightPort}`
    }
  },
});
