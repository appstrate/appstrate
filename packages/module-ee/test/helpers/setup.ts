// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

// This module reads the platform only through `services.usage` and the two org
// queries, so its tests seed those two seams in memory instead of platform rows.

import { afterAll, beforeAll } from "bun:test";
import {
  getAppUrl,
  getPlatformServices,
  setAppUrl,
  setPlatformServices,
} from "../../src/platform.ts";
import type { PlatformServices } from "@appstrate/core/module";
import { getOrgQueries, setOrgQueries, type EeOrgQueries } from "../../src/platform-org-queries.ts";
import { mockPlatformServices } from "./mock-platform.ts";
import { orgQueries } from "./org-queries.ts";
import { startStripeMock } from "./stripe.ts";

/**
 * Point the module's three `init(ctx)` seams at the in-memory doubles for the
 * duration of ONE test file, then hand them back.
 *
 * The handles are process-global, and the preload has already `init()`d the
 * real module against the test platform — so a file that installed the mocks
 * and walked away would leave every later file (the platform's own admission
 * tests included) running through whichever doubles the file ordering happened
 * to leave behind. Install in `beforeAll`, restore in `afterAll`: call this at
 * the top level of a test file and the swap is scoped to it.
 */
export function useEeTestSeams(): void {
  let previousServices: PlatformServices;
  let previousQueries: EeOrgQueries;
  let previousAppUrl: string;

  beforeAll(() => {
    // Before the first `getStripe()`, which caches host + port and honors the mock
    // only under NODE_ENV=test — forced for a box whose `.env` pins it otherwise.
    process.env.NODE_ENV = "test";
    const { port } = startStripeMock();
    process.env.STRIPE_MOCK_HOST = "localhost";
    process.env.STRIPE_MOCK_PORT = String(port);

    previousServices = getPlatformServices();
    previousQueries = getOrgQueries();
    previousAppUrl = getAppUrl();

    setPlatformServices(mockPlatformServices);
    setOrgQueries(orgQueries);
    // The billing emails build absolute CTA links from it, exactly as at boot.
    setAppUrl("http://localhost:3000");
  });

  afterAll(() => {
    setPlatformServices(previousServices);
    setOrgQueries(previousQueries);
    setAppUrl(previousAppUrl);
  });
}
