// SPDX-License-Identifier: Apache-2.0

/**
 * Migration `0030`: the pure planner against a synthetic catalog. The run against a database is
 * no longer tested: the script ran in the beta.62 window, and `org_models.credential_id`, which
 * it reads, left the drizzle schema with migration 0119 (model configurations, #2451) and is
 * dropped from SQL in the release after. The script stays as the record of what ran.
 */

import { describe, expect, it } from "bun:test";
import {
  planPiCatalogMigration,
  type CatalogView,
  type OrgModelRow,
  type PiCatalogSnapshot,
} from "../migration/0030-pi-catalog-org-models.ts";

// ─── The pure planner ─────────────────────────────────────
const ORG = "00000000-0000-4000-8000-000000000301";
const OTHER_ORG = "00000000-0000-4000-8000-000000000302";

/** `named` offers `known`, `strict`, `warm` and features `warm` then `known`; `gateway` takes anything. */
const catalog: CatalogView = {
  offers: (providerId, modelId) =>
    providerId === "gateway"
      ? true
      : providerId === "named"
        ? ["known", "strict", "warm"].includes(modelId)
        : null,
  featured: (providerId) => (providerId === "named" ? ["warm", "known"] : []),
};

const row = (id: string, providerId: string, modelId: string, extra: Partial<OrgModelRow> = {}) =>
  ({
    id,
    orgId: ORG,
    credentialId: `cred-${providerId}`,
    providerId,
    modelId,
    enabled: true,
    ...extra,
  }) satisfies OrgModelRow;

const UNKNOWN = row("m-unknown", "named", "retired-model");
const KNOWN = row("m-known", "named", "known");
const STRICT = row("m-strict", "named", "strict");
const WARM = row("m-warm", "named", "warm");
const GATEWAY = row("m-gateway", "gateway", "anything-goes");
const ORPHAN = row("m-orphan", "gone-module", "whatever");

const snapshot = (over: Partial<PiCatalogSnapshot> = {}): PiCatalogSnapshot => ({
  orgModels: [UNKNOWN, KNOWN, STRICT, WARM, GATEWAY, ORPHAN],
  orgDefaults: [],
  spacePins: [],
  scheduleOverrides: [],
  ...over,
});

describe("planPiCatalogMigration", () => {
  it("deletes a named-provider row outside the offer, clears the pins naming it, leaves an unregistered provider alone", () => {
    const plan = planPiCatalogMigration(
      snapshot({
        spacePins: [
          { spaceId: "s1", packageId: "@o/a", modelId: UNKNOWN.id },
          { spaceId: "s1", packageId: "@o/b", modelId: KNOWN.id },
        ],
        scheduleOverrides: [
          { scheduleId: "sch_1", modelId: UNKNOWN.id },
          { scheduleId: "sch_2", modelId: GATEWAY.id },
          { scheduleId: "sch_3", modelId: ORPHAN.id },
        ],
      }),
      catalog,
    );
    expect(plan.deletions.map((r) => r.id)).toEqual([UNKNOWN.id]);
    expect(plan.unregistered.map((r) => r.id)).toEqual([ORPHAN.id]);
    expect(plan.clearedSpacePins).toEqual([{ spaceId: "s1", packageId: "@o/a", from: UNKNOWN.id }]);
    expect(plan.clearedScheduleOverrides).toEqual([{ scheduleId: "sch_1", from: UNKNOWN.id }]);
  });

  it("repoints a deleted org default to the first featured survivor of the same credential", () => {
    const plan = planPiCatalogMigration(
      snapshot({
        orgDefaults: [
          { orgId: ORG, modelId: UNKNOWN.id },
          { orgId: OTHER_ORG, modelId: "m-other" },
        ],
      }),
      catalog,
    );
    // `known` is older, but `warm` is featured first.
    expect(plan.orgDefaults).toEqual([{ orgId: ORG, from: UNKNOWN.id, to: WARM.id }]);
  });

  it("falls back to the oldest survivor when none is featured", () => {
    const plan = planPiCatalogMigration(
      snapshot({
        orgModels: [
          UNKNOWN,
          row("m-strict-old", "named", "strict"),
          row("m-strict-new", "named", "strict"),
        ],
        orgDefaults: [{ orgId: ORG, modelId: UNKNOWN.id }],
      }),
      catalog,
    );
    expect(plan.orgDefaults).toEqual([{ orgId: ORG, from: UNKNOWN.id, to: "m-strict-old" }]);
  });

  it("repoints to NULL when no enabled row of the same credential and org survives", () => {
    const plan = planPiCatalogMigration(
      snapshot({
        orgModels: [
          UNKNOWN,
          row("m-disabled", "named", "known", { enabled: false }),
          row("m-other-cred", "named", "strict", { credentialId: "cred-2" }),
          row("m-other-org", "named", "strict", { orgId: OTHER_ORG }),
        ],
        orgDefaults: [{ orgId: ORG, modelId: UNKNOWN.id }],
      }),
      catalog,
    );
    expect(plan.orgDefaults).toEqual([{ orgId: ORG, from: UNKNOWN.id, to: null }]);
  });
});
