import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 3418);
const BASE_URL = `http://localhost:${PORT}`;

/**
 * E2E runs against a production build on deterministic fixture data
 * (NEXT_PUBLIC_DATA_SOURCE=fixtures), written to .next-e2e so it never clobbers the real build.
 */
export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 15_000, toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: "disabled" } },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 3,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never" }]],
  snapshotPathTemplate: "{testDir}/__screenshots__/{testFileName}/{arg}{ext}",
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    colorScheme: "dark",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /responsive|stage|console-errors/ },
    { name: "console", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testMatch: /console-errors/ },
    { name: "stage", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } }, testMatch: /stage/ },
    { name: "mobile-375", use: { ...devices["iPhone 13 mini"], viewport: { width: 375, height: 812 }, browserName: "chromium" }, testMatch: /responsive/ },
    { name: "mobile-414", use: { ...devices["Pixel 7"], viewport: { width: 414, height: 896 }, browserName: "chromium" }, testMatch: /responsive/ },
    { name: "tablet-768", use: { ...devices["Desktop Chrome"], viewport: { width: 768, height: 1024 }, hasTouch: true }, testMatch: /responsive/ },
    { name: "laptop-1024", use: { ...devices["Desktop Chrome"], viewport: { width: 1024, height: 768 } }, testMatch: /responsive/ },
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testMatch: /responsive/ },
    { name: "wide-1920", use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } }, testMatch: /responsive/ },
  ],
  webServer: {
    command: `NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_DATA_SOURCE=fixtures pnpm exec next build && NEXT_DIST_DIR=.next-e2e NEXT_PUBLIC_DATA_SOURCE=fixtures pnpm exec next start --port ${PORT}`,
    url: BASE_URL,
    timeout: 300_000,
    reuseExistingServer: !process.env.CI,
    stdout: "ignore",
    stderr: "pipe",
  },
});
