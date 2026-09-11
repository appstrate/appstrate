// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

import Stripe from "stripe";
import { getEeEnv } from "../env.ts";

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (!_stripe) {
    _stripe = new Stripe(getEeEnv().STRIPE_SECRET_KEY, {
      apiVersion: "2026-08-26.dahlia",
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
