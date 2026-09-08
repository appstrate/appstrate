// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The two platform seams these tests drive themselves, installed over what the
 * root preload wired.
 *
 * The preload initializes every discovered module with the REAL init context —
 * real platform services, real org queries — which is what makes a module's
 * tests exercise the wiring production uses. This module is the one that then
 * needs the opposite: it runs its own database and reads the platform ONLY
 * through `services.usage` and the two org queries, so its billing tests seed
 * an in-memory ledger and an in-memory org directory rather than platform rows
 * (`mock-platform.ts`, `org-queries.ts`). Both are plain module-level holders
 * with public setters, so swapping them is a call, not a mock.
 *
 * Idempotent and called from the top of each integration test file: `bun test`
 * runs the whole suite in one process, so the first file to load installs the
 * seams for all of them.
 */

import { setPlatformServices } from "../../src/platform.ts";
import { setOrgQueries } from "../../src/platform-org-queries.ts";
import { mockPlatformServices } from "./mock-platform.ts";
import { orgQueries } from "./org-queries.ts";
import { startStripeMock } from "./stripe.ts";

let installed = false;

export function useEeTestSeams(): void {
  if (installed) return;
  installed = true;

  // Before the first `getStripe()`: the Stripe client caches host + port when
  // it is constructed, and honors the mock host only under `NODE_ENV=test`
  // (`src/stripe/client.ts`). `bun test` already sets that; forcing it here
  // covers the box whose `.env` pins `NODE_ENV` to something else, where the
  // suite would otherwise talk to api.stripe.com.
  process.env.NODE_ENV = "test";
  const { port } = startStripeMock();
  process.env.STRIPE_MOCK_HOST = "localhost";
  process.env.STRIPE_MOCK_PORT = String(port);

  setPlatformServices(mockPlatformServices);
  setOrgQueries(orgQueries);
}
