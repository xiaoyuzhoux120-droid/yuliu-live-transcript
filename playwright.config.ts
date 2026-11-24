import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.E2E_PORT ?? 5173);
const baseURL = process.env.E2E_BASE_URL ?? `http://127.0.0.1:${PORT}`;

// Only Chromium ships in CI/dev containers by default. Firefox/WebKit
// behaviour is covered by API-level simulations in tests/e2e/compat.spec.ts;
// set E2E_ALL_BROWSERS=1 after `npx playwright install firefox webkit` to run
// the real engines too.
const extraBrowsers = process.env.E2E_ALL_BROWSERS
  ? [
      { name: "firefox", use: { ...devices["Desktop Firefox"] } },
      { name: "webkit", use: { ...devices["Desktop Safari"] } },
    ]
  : [];

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "off",
    // Synthetic tone instead of a real microphone; no user audio is involved.
    launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] },
    permissions: ["microphone"],
  },
  projects: [
    { name: "chromium-desktop", use: { ...devices["Desktop Chrome"], launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } } },
    { name: "chromium-mobile", use: { ...devices["Pixel 7"], launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } } },
    ...extraBrowsers,
  ],
  webServer: process.env.E2E_BASE_URL
    ? undefined
    : {
        // Dev server provides the mock ChatGPT sign-in (build/sites-vite-plugin.ts).
        command: "npm run dev",
        url: `http://127.0.0.1:${PORT}/transcript.js`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
