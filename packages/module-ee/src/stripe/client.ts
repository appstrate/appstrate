// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import Stripe from "stripe";
import { getEeEnv } from "../env.ts";

/**
 * The Stripe API version every request in this module is rendered at.
 *
 * `satisfies Stripe.LatestApiVersion` is the tripwire: that type is a single
 * string LITERAL, so a Dependabot bump of `stripe` that ships a newer version
 * turns this line into a hard TS2322 and drags the pin forward with the SDK.
 * It is exported so the live contract suite (`test/live`) pins the same version
 * instead of restating the literal in a file that would keep agreeing with an
 * API version production no longer speaks.
 */
export const STRIPE_API_VERSION = "2026-08-26.dahlia" satisfies Stripe.LatestApiVersion;

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(getEeEnv().STRIPE_SECRET_KEY, {
      apiVersion: STRIPE_API_VERSION,
      // Mock-host redirect is a TEST-ONLY hook. Gating on NODE_ENV keeps an
      // operator-set STRIPE_MOCK_HOST from silently rerouting production Stripe
      // traffic to an arbitrary host over plain HTTP.
      ...(process.env.NODE_ENV === "test" &&
        process.env.STRIPE_MOCK_HOST && {
          host: process.env.STRIPE_MOCK_HOST,
          port: Number(process.env.STRIPE_MOCK_PORT ?? 12111),
          protocol: "http" as const,
          maxNetworkRetries: 0,
        }),
    });
  }
  return _stripe;
}
