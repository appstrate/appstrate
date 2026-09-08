// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth's rate limiter keys on the client IP the PLATFORM resolved.
 *
 * Better Auth resolves an address from request headers alone, and its two
 * trust models do not translate: `TRUST_PROXY` is a hop COUNT, its
 * `trustedProxies` a list of proxy addresses. So `lib/client-ip.ts` resolves
 * the address and states it on `CLIENT_IP_HEADER`, the mount point stamps it
 * on the request handed to `auth.handler`, and `advanced.ipAddress`
 * (`packages/db/src/auth.ts`) names that header and nothing else.
 *
 * The bucket under test is Better Auth's own `/sign-in*` rule — 3 requests
 * per 10 seconds per IP.
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { getTestApp } from "../../helpers/app.ts";
import { truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { _resetCacheForTesting } from "@appstrate/env";
import { CLIENT_IP_HEADER, resetClientIpCache } from "../../../src/lib/client-ip.ts";

const app = getTestApp();

const SIGN_IN_MAX = 3;
const originalTrustProxy = process.env.TRUST_PROXY;

function setTrustProxy(value: string): void {
  process.env.TRUST_PROXY = value;
  _resetCacheForTesting();
  resetClientIpCache();
}

afterAll(() => {
  if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = originalTrustProxy;
  _resetCacheForTesting();
  resetClientIpCache();
});

/** One sign-in attempt with bogus credentials — 401 until the bucket is spent. */
async function attemptSignIn(headers: Record<string, string>): Promise<number> {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ email: "nobody@example.com", password: "WrongPassword123!" }),
  });
  return res.status;
}

async function spendBudget(headers: Record<string, string>): Promise<void> {
  for (let i = 0; i < SIGN_IN_MAX; i++) {
    expect(await attemptSignIn(headers)).not.toBe(429);
  }
}

describe("Better Auth rate limiting keys on the platform-resolved client IP", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
  });

  it("gives two forwarded client IPs two buckets when the proxy is trusted", async () => {
    setTrustProxy("true");

    await spendBudget({ "X-Forwarded-For": "203.0.113.10" });
    expect(await attemptSignIn({ "X-Forwarded-For": "203.0.113.10" })).toBe(429);

    // A different client behind the same proxy still has its own budget —
    // which only holds if the address Better Auth keyed on is the one the
    // platform resolved from the forwarded chain.
    expect(await attemptSignIn({ "X-Forwarded-For": "203.0.113.11" })).not.toBe(429);
  });

  it("ignores a forwarded chain the platform does not trust", async () => {
    setTrustProxy("false");

    await spendBudget({});
    // `TRUST_PROXY=false` means the platform resolves no address from the
    // header, so it stamps none — and Better Auth, reading only the stamp,
    // cannot be handed a fresh bucket by a caller inventing a hop.
    expect(await attemptSignIn({ "X-Forwarded-For": "198.51.100.7" })).toBe(429);
  });

  it("drops a caller-supplied client-IP stamp", async () => {
    setTrustProxy("false");

    await spendBudget({});
    expect(await attemptSignIn({ [CLIENT_IP_HEADER]: "198.51.100.8" })).toBe(429);
  });
});
