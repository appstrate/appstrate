// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * The key-free half of the Stripe contract check.
 *
 * `test/live/stripe-contract.test.ts` proves the fields the fixtures carry
 * still exist on a real Stripe response — but it needs `STRIPE_LIVE_SECRET_KEY`
 * and skips itself everywhere else, which is most places. This file asserts the
 * complementary direction, which needs nothing: that every path production
 * dereferences RESOLVES on the fixture the mocked suite serves.
 *
 * That direction is the one the typechecker cannot cover. `Fixture<T>` (test/
 * helpers/stripe.ts) makes every field optional, so it catches a fixture
 * claiming a field Stripe does not have — it cannot catch a fixture quietly
 * MISSING one, which is precisely how `current_period_end` read `undefined` in
 * every test for the life of the 2025-03-31 relocation.
 */

import { describe, expect, it } from "bun:test";
import {
  INVOICE_READS,
  SUBSCRIPTION_READS,
  defaultSubscriptionResponse,
  fullInvoiceFixture,
  valueAtPath,
} from "../helpers/stripe.ts";

describe("Stripe fixtures carry the fields production reads", () => {
  for (const path of SUBSCRIPTION_READS) {
    it(`subscription fixture has ${path}`, () => {
      expect(valueAtPath(defaultSubscriptionResponse("sub_shape"), path)).toBeDefined();
    });
  }

  for (const path of INVOICE_READS) {
    it(`invoice fixture has ${path}`, () => {
      expect(valueAtPath(fullInvoiceFixture(), path)).toBeDefined();
    });
  }
});
