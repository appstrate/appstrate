// SPDX-License-Identifier: Apache-2.0

/**
 * The runtime boundary under `useBilling`'s cast.
 *
 * `cloudApi` is a hand-rolled `fetch` + `JSON.parse` + cast — the `/api/billing`
 * routes come from the private cloud module and are absent from the OSS OpenAPI
 * spec, so the typed client cannot express them and nothing validates the
 * payload. `file_storage_bytes` is typed required; these pin that the type is
 * enforced rather than merely declared.
 *
 * Why it matters that this throws: `formatBytes(undefined)` returns the string
 * `"undefined B"`, so an absent field renders a plan priced at
 * "undefined B de stockage" and nobody hears about it.
 */

import { describe, expect, it } from "bun:test";
import { assertPlansPriced, type BillingPlanDetail } from "../use-billing.ts";

const plan = (id: string, over: Partial<BillingPlanDetail> = {}): BillingPlanDetail => ({
  id,
  name: id,
  price: 0,
  credit_quota: 1000,
  file_storage_bytes: 1024,
  ...over,
});

const payload = (plans: BillingPlanDetail[], upgrades: BillingPlanDetail[] = []) => ({
  plan: { id: "free", name: "Free" },
  plans,
  usage_percent: 0,
  credits_used: 0,
  credit_quota: 1000,
  period_end: null,
  status: "active" as const,
  upgrades,
});

describe("assertPlansPriced", () => {
  it("passes a fully priced payload through unchanged", () => {
    const info = payload([plan("free"), plan("pro")], [plan("pro")]);

    expect(assertPlansPriced(info)).toBe(info);
  });

  it("accepts a zero entitlement — zero is a price, not a missing field", () => {
    const info = payload([plan("free", { file_storage_bytes: 0 })]);

    expect(assertPlansPriced(info)).toBe(info);
  });

  it("throws when a plan omits file_storage_bytes", () => {
    const unpriced = { ...plan("free") } as Partial<BillingPlanDetail>;
    delete unpriced.file_storage_bytes;

    expect(() => assertPlansPriced(payload([unpriced as BillingPlanDetail]))).toThrow(
      /missing file_storage_bytes/,
    );
  });

  /**
   * `upgrades` is a second projection of the same plan shape and feeds the same
   * card, so checking only `plans` would leave the identical hazard on the
   * billing settings page.
   */
  it("checks upgrades as well as plans", () => {
    const unpriced = { ...plan("pro") } as Partial<BillingPlanDetail>;
    delete unpriced.file_storage_bytes;

    expect(() =>
      assertPlansPriced(payload([plan("free")], [unpriced as BillingPlanDetail])),
    ).toThrow(/missing file_storage_bytes/);
  });

  it("names every offending plan so the operator knows what to look at", () => {
    const strip = (id: string): BillingPlanDetail => {
      const p = { ...plan(id) } as Partial<BillingPlanDetail>;
      delete p.file_storage_bytes;
      return p as BillingPlanDetail;
    };

    expect(() => assertPlansPriced(payload([strip("free"), plan("pro"), strip("team")]))).toThrow(
      /2 plan\(s\): free, team/,
    );
  });

  /**
   * A `null` from a producer that has the field but leaves it unset must fail
   * the same way: `formatBytes(null as unknown as number)` renders "null B",
   * which is the same silent nonsense as "undefined B".
   */
  it("rejects a non-numeric value, not just an absent key", () => {
    expect(() =>
      assertPlansPriced(payload([plan("free", { file_storage_bytes: null as unknown as number })])),
    ).toThrow(/missing file_storage_bytes/);
  });
});
