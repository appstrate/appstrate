// SPDX-License-Identifier: Apache-2.0

import { defineConfig } from "@playwright/test";
import { E2E_BASE_URL, E2E_PORT } from "./helpers/base-url.ts";

export default defineConfig({
  testDir: "./tests",
  fullyParallel: false,
  retries: 2,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [["list"], ["html", { open: "never" }]],

  use: {
    baseURL: E2E_BASE_URL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },

  projects: [
    {
      name: "api",
      testMatch: /.*\.api\.spec\.ts/,
    },
    {
      name: "ui",
      testMatch: /.*\.ui\.spec\.ts/,
      use: {
        browserName: "chromium",
        viewport: { width: 1280, height: 720 },
      },
    },
  ],

  webServer: {
    command: "cd .. && bun --hot apps/api/src/index.ts",
    url: E2E_BASE_URL,
    reuseExistingServer: true,
    timeout: 120_000,
    // Playwright already spreads `process.env` underneath this map, so only the
    // keys the suite pins are listed. At the default port every value below is
    // byte-identical to what the API resolves on its own — `E2E_PORT` is the
    // only thing that moves them.
    env: {
      PORT: String(E2E_PORT),
      APP_URL: E2E_BASE_URL,
      TRUSTED_ORIGINS: `${E2E_BASE_URL},http://localhost:5173`,
      // tests/models/custom-model.ui.spec.ts points the platform at a mock
      // OpenAI-compatible endpoint on 127.0.0.1; the SSRF guard blocks
      // loopback unless the operator trusts it explicitly.
      EGRESS_ALLOW_INTERNAL_HOSTS: "127.0.0.1,localhost",
    },
  },
});
