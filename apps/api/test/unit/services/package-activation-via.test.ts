// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  isActiveByDefault,
  isActiveWithoutRow,
  placementVia,
  type PlacementVia,
} from "../../../src/services/package-activation.ts";
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
  orgOffer: null,
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
  ["system, offered, no row", system({ orgOffer: "on_by_default" }), undefined, "system"],
  ["system, offered, a row", system({ orgOffer: "on_by_default" }), SHARE, "system"],
  // System integration the deployment does NOT offer: only the org's offer activates it.
  [
    "unlisted system integration, offered, no row",
    system({ type: "integration", orgOffer: "on_by_default" }),
    undefined,
    "organization",
  ],
  [
    "unlisted system integration, offered, a row",
    system({ type: "integration", orgOffer: "on_by_default" }),
    OFFER_ROW,
    "organization",
  ],
  [
    "unlisted system integration, offered, a share row",
    system({ type: "integration", orgOffer: "on_by_default" }),
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
    system({ type: "integration", id: OFFERED_SYSTEM_INTEGRATION, orgOffer: "on_by_default" }),
    undefined,
    "system",
  ],
  // Homed package.
  ["homed here", local({ homeSpaceId: SPACE }), undefined, "home"],
  ["homed here, with a share row", local({ homeSpaceId: SPACE }), SHARE, "home"],
  ["homed elsewhere, share row", local(), SHARE, "shared"],
  [
    "homed elsewhere, offer row, offered",
    local({ orgOffer: "on_by_default" }),
    OFFER_ROW,
    "organization",
  ],
  [
    "homed elsewhere, offered, no row",
    local({ orgOffer: "on_by_default" }),
    undefined,
    "organization",
  ],
  ["homed elsewhere, share row, offered", local({ orgOffer: "on_by_default" }), SHARE, "shared"],
  ["homed elsewhere, offer row, offer withdrawn", local(), OFFER_ROW, "shared"],
  // An `available` offer places exactly as an `on_by_default` one does.
  [
    "homed elsewhere, available, no row",
    local({ orgOffer: "available" }),
    undefined,
    "organization",
  ],
  [
    "homed elsewhere, available, offer row",
    local({ orgOffer: "available" }),
    OFFER_ROW,
    "organization",
  ],
  ["homed elsewhere, available, share row", local({ orgOffer: "available" }), SHARE, "shared"],
  [
    "unlisted system integration, available, no row",
    system({ type: "integration", orgOffer: "available" }),
    undefined,
    "organization",
  ],
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

describe("isActiveByDefault", () => {
  beforeEach(() => {
    __resetSystemIntegrationsForTest();
    initSystemIntegrations([{ id: OFFERED_SYSTEM_INTEGRATION, clients: [] }]);
  });
  afterEach(() => __resetSystemIntegrationsForTest());

  it("is the deployment default alone, an offer not counting", () => {
    expect(isActiveByDefault(system())).toBe(true);
    expect(isActiveByDefault(system({ type: "integration", id: OFFERED_SYSTEM_INTEGRATION }))).toBe(
      true,
    );
    expect(isActiveByDefault(system({ type: "integration" }))).toBe(false);
    expect(isActiveByDefault(local({ orgOffer: "on_by_default" }))).toBe(false);
  });

  it("activates without a row only for an on_by_default offer", () => {
    expect(isActiveWithoutRow(local({ orgOffer: "on_by_default" }))).toBe(true);
    expect(isActiveWithoutRow(local({ orgOffer: "available" }))).toBe(false);
    expect(isActiveWithoutRow(local({ orgOffer: null }))).toBe(false);
    expect(isActiveWithoutRow(system({ orgOffer: "available" }))).toBe(true);
  });

  it("is what isActiveWithoutRow reads once the offer is set aside", () => {
    for (const [, pkg] of CELLS) {
      expect(isActiveWithoutRow({ ...pkg, orgOffer: null })).toBe(isActiveByDefault(pkg));
    }
  });
});
