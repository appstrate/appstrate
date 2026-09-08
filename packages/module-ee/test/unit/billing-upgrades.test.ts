// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * `upgradeOptions` — which plans `GET /api/billing` offers above the current
 * tier.
 *
 * The offer and the checkout schema read the same `CHECKOUT_PLAN_IDS`; a plan
 * offered but not accepted is a button that 400s. Pure, so the catalog is fed
 * in rather than assembled from the environment.
 */
import { describe, expect, it } from "bun:test";
import { upgradeOptions } from "../../src/routes/billing.ts";
import { GIB, type PlanDefinition } from "../../src/config.ts";

function plan(id: string, tier: number, stripePriceId: string | null): PlanDefinition {
  return {
    id,
    name: id,
    tier,
    creditQuota: 1000 * tier,
    fileStorageBytes: GIB,
    monthlyPrice: 10 * tier,
    stripePriceId,
  };
}

const free = plan("free", 0, null);
const starter = plan("starter", 1, "price_starter");
const pro = plan("pro", 2, "price_pro");

describe("upgradeOptions", () => {
  it("offers every checkout plan above the current tier", () => {
    expect(upgradeOptions([free, starter, pro], 0).map((p) => p.id)).toEqual(["starter", "pro"]);
    expect(upgradeOptions([free, starter, pro], 1).map((p) => p.id)).toEqual(["pro"]);
    expect(upgradeOptions([free, starter, pro], 2)).toEqual([]);
  });

  it("never offers a plan with no Stripe price", () => {
    expect(upgradeOptions([free, starter], 0).map((p) => p.id)).not.toContain("free");
  });

  it("never offers a priced plan absent from CHECKOUT_PLAN_IDS", () => {
    // The failure this guards: a plan given a Stripe price but not added to
    // CHECKOUT_PLAN_IDS was offered as an upgrade, and the checkout schema —
    // which reads that same constant — then rejected the id it had just been
    // handed.
    const enterprise = plan("enterprise", 3, "price_enterprise");
    expect(upgradeOptions([free, starter, pro, enterprise], 0).map((p) => p.id)).toEqual([
      "starter",
      "pro",
    ]);
  });

  it("projects the wire shape", () => {
    expect(upgradeOptions([starter], 0)).toEqual([
      {
        id: "starter",
        name: "starter",
        price: 10,
        credit_quota: 1000,
        file_storage_bytes: GIB,
      },
    ]);
  });
});
