// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

// This module reads the platform only through `services.usage` and the two org
// queries, so its tests seed those two seams in memory instead of platform rows.

import { setPlatformServices } from "../../src/platform.ts";
import { setOrgQueries } from "../../src/platform-org-queries.ts";
import { mockPlatformServices } from "./mock-platform.ts";
import { orgQueries } from "./org-queries.ts";
import { startStripeMock } from "./stripe.ts";

let installed = false;

export function useEeTestSeams(): void {
  if (installed) return;
  installed = true;

  // Before the first `getStripe()`, which caches host + port and honors the mock
  // only under NODE_ENV=test — forced for a box whose `.env` pins it otherwise.
  process.env.NODE_ENV = "test";
  const { port } = startStripeMock();
  process.env.STRIPE_MOCK_HOST = "localhost";
  process.env.STRIPE_MOCK_PORT = String(port);

  setPlatformServices(mockPlatformServices);
  setOrgQueries(orgQueries);
}
