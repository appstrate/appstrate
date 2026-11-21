// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { placementVia, type PlacementVia } from "../../../src/services/package-activation.ts";
import {
  initSystemIntegrations,
  __resetSystemIntegrationsForTest,
} from "../../../src/services/integration-client-registry.ts";

const SPACE = "spc_here";
const OTHER = "spc_other";
const OFFERED_SYSTEM_INTEGRATION = "@appstrate/integration-offered";

type Pkg = Parameters<typeof placementVia>[0];
type Row = Parameters<typeof placementVia>[2];

const local = (over: Partial<Pkg> = {}): Pkg => ({
  id: "@acme/thing",
  type: "skill",
  source: "local",
  homeSpaceId: OTHER,
  offeredToOrg: false,
  ...over,
});
const system = (over: Partial<Pkg> = {}): Pkg =>
  local({ source: "system", homeSpaceId: null, ...over });

const SHARE: Row = { placedByOffer: false };
const OFFER_ROW: Row = { placedByOffer: true };

const CELLS: Array<[string, Pkg, Row, PlacementVia | null]> = [
  // System package (non-integration): on by default, so the offer is moot.
  ["system, no row", system(), undefined, "system"],
  ["system, a row", system(), SHARE, "system"],
  ["system, offered, no row", system({ offeredToOrg: true }), undefined, "system"],
  ["system, offered, a row", system({ offeredToOrg: true }), SHARE, "system"],
  // System integration the deployment does NOT offer: only the org's offer activates it.
  [
    "unlisted system integration, offered, no row",
    system({ type: "integration", offeredToOrg: true }),
    undefined,
    "organization",
  ],
  [
    "unlisted system integration, offered, a row",
    system({ type: "integration", offeredToOrg: true }),
    OFFER_ROW,
    "organization",
  ],
  [
    "unlisted system integration, offered, a share row",
    system({ type: "integration", offeredToOrg: true }),
    SHARE,
    "system",
  ],
  [
    "unlisted system integration, not offered, no row",
    system({ type: "integration" }),
    undefined,
    "system",
  ],
  // System integration in SYSTEM_INTEGRATIONS: on by default, offer or not.
  [
    "listed system integration, offered, no row",
    system({ type: "integration", id: OFFERED_SYSTEM_INTEGRATION, offeredToOrg: true }),
    undefined,
    "system",
  ],
  // Homed package.
  ["homed here", local({ homeSpaceId: SPACE }), undefined, "home"],
  ["homed here, with a share row", local({ homeSpaceId: SPACE }), SHARE, "home"],
  ["homed elsewhere, share row", local(), SHARE, "shared"],
  ["homed elsewhere, offer row, offered", local({ offeredToOrg: true }), OFFER_ROW, "organization"],
  ["homed elsewhere, offered, no row", local({ offeredToOrg: true }), undefined, "organization"],
  ["homed elsewhere, share row, offered", local({ offeredToOrg: true }), SHARE, "shared"],
  ["homed elsewhere, offer row, offer withdrawn", local(), OFFER_ROW, "shared"],
  ["homed elsewhere, not placed", local(), undefined, null],
];

describe("placementVia", () => {
  beforeEach(() => {
    __resetSystemIntegrationsForTest();
    initSystemIntegrations([{ id: OFFERED_SYSTEM_INTEGRATION, clients: [] }]);
  });
  afterEach(() => __resetSystemIntegrationsForTest());

  for (const [label, pkg, row, expected] of CELLS) {
    it(`${label} -> ${expected}`, () => {
      expect(placementVia(pkg, SPACE, row)).toBe(expected);
    });
  }
});
