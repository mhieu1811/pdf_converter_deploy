import { defineConfig } from "@playwright/test";

const remote = process.env.BASE_URL;
// Vercel preview deployments are login-protected by default; this secret lets the tests through
// (Project Settings > Deployment Protection > Protection Bypass for Automation).
const bypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
// PROD_BUILD=1 tests the real production bundle instead of the build that carries test hooks.
const build = process.env.PROD_BUILD ? "npm run build" : "npm run build:e2e";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: "**/*.spec.ts",
  timeout: 15 * 60 * 1000,
  workers: 1,
  fullyParallel: false,
  reporter: [["list"]],
  outputDir: ".test-artifacts/playwright",
  use: {
    baseURL: remote ?? "http://localhost:4173",
    acceptDownloads: true,
    ...(remote && bypass ? { extraHTTPHeaders: { "x-vercel-protection-bypass": bypass } } : {}),
    // Traces and screenshots could capture document content.
    trace: "off",
    screenshot: "off",
    video: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
  webServer: remote
    ? undefined
    : {
        command: `${build} && vite preview --port 4173 --strictPort`,
        url: "http://localhost:4173",
        timeout: 5 * 60 * 1000,
        reuseExistingServer: false,
      },
});
