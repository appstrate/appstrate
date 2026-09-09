// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

// This module reads the platform only through `services.usage` and the two org
// queries, so its tests seed those two seams in memory instead of platform rows.

import { afterAll, beforeAll } from "bun:test";
import { _resetEeEnvForTests } from "../../src/env.ts";
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
  const previousEnv: Record<string, string | undefined> = {};

  const SWAPPED_ENV = ["NODE_ENV", "STRIPE_MOCK_HOST", "STRIPE_MOCK_PORT"] as const;

  beforeAll(() => {
    for (const key of SWAPPED_ENV) previousEnv[key] = process.env[key];

    // Before the first `getStripe()`, which caches host + port and honors the mock
    // only under NODE_ENV=test — forced for a box whose `.env` pins it otherwise.
    process.env.NODE_ENV = "test";
    // The mock server itself is process-lifetime and idempotent: a second call
    // returns the port the first one bound. Only the env pointing at it is
    // file-scoped, because that is what a later file can be misled by.
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
    for (const key of SWAPPED_ENV) {
      const previous = previousEnv[key];
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });
}

/**
 * Scope the reconciliation knobs a sweep test rewrites (`EE_RECONCILIATION_*`)
 * to ONE test file, then hand them back and drop the cached env.
 *
 * `test/requirements.ts` pins `EE_RECONCILIATION_INTERVAL_SECONDS` to `"0"` on
 * purpose — a timer firing mid-suite bills rows a later file seeded into the
 * ledger. A file that sets an interval and walks away arms that timer for every
 * file after it. Call this at the top level of a file whose tests write any of
 * the three.
 */
export function useEeReconciliationEnv(): void {
  const KNOBS = [
    "EE_RECONCILIATION_INTERVAL_SECONDS",
    "EE_RECONCILIATION_BATCH_SIZE",
    "EE_RECONCILIATION_REPLAY_WINDOW",
  ] as const;

  const previous: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of KNOBS) previous[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of KNOBS) {
      const before = previous[key];
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
    _resetEeEnvForTests();
  });
}
