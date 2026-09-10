// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth sees the client IP the PLATFORM resolved, and only that one.
 *
 * Better Auth resolves an address from request headers alone, and its two
 * trust models do not translate: `TRUST_PROXY` is a hop COUNT, its
 * `trustedProxies` a list of proxy addresses. So `lib/client-ip.ts` resolves
 * the address, the edge middleware `middleware/client-ip.ts` overwrites
 * `CLIENT_IP_HEADER` on the inbound request with it, and `advanced.ipAddress`
 * (`packages/db/src/auth.ts`) names that header and nothing else.
 *
 * Both ways into Better Auth are covered, because they read the headers
 * differently: the `/api/auth/*` handler mount (buckets asserted through its
 * own `/sign-in*` rule — 3 requests per 10 seconds per IP) and a route calling
 * `auth.api.*` with `c.req.raw.headers` (asserted through the `session.ipAddress`
 * the signup it performs records).
 */

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { session, user } from "@appstrate/db/schema";
import {
  _rebuildAuthForTesting,
  setPostBootstrapOrgHook,
  setRealmResolver,
} from "@appstrate/db/auth";
import { getTestApp } from "../../helpers/app.ts";
import { db, truncateAll } from "../../helpers/db.ts";
import { flushRedis } from "../../helpers/redis.ts";
import { _resetCacheForTesting } from "@appstrate/env";
import { _resetBootstrapTokenForTesting } from "../../../src/lib/bootstrap-token.ts";
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

  // #1316 — the spoof the resolver's old leftmost clamp allowed, asserted where
  // it mattered: at the limiter. Two trusted hops means the chain must carry at
  // least two entries; a one-entry chain was written by the caller alone, so it
  // must not mint a bucket of its own.
  it("refuses a forwarded chain shorter than the trusted hop count", async () => {
    setTrustProxy("2");

    await spendBudget({});
    expect(await attemptSignIn({ "X-Forwarded-For": "203.0.113.12" })).toBe(429);
    // A second invented address does not buy a second budget either.
    expect(await attemptSignIn({ "X-Forwarded-For": "203.0.113.13" })).toBe(429);
  });

  // #1316 sub-defect — a chain entry that is not an address resolves to
  // nothing, so it mints no bucket. In production the socket peer takes over
  // from there; under `app.request()` there is no socket, which is why this
  // asserts only that the junk value bought nothing.
  it("refuses a forwarded entry that is not an IP address", async () => {
    setTrustProxy("true");

    await spendBudget({});
    expect(await attemptSignIn({ "X-Forwarded-For": "not-an-ip" })).toBe(429);
  });
});

/**
 * The handler mount above is one of two ways into Better Auth. The other is a
 * route calling `auth.api.*` with `c.req.raw.headers` — over twenty of those
 * exist, and none of them can be asked to remember the stamp. Stamping at the
 * edge is what covers them: `POST /api/auth/bootstrap/redeem` hands those raw
 * headers to `auth.api.signUpEmail`, which records `session.ipAddress` from
 * them, so the row it writes says which address Better Auth was given.
 */
describe("an auth.api-backed route hands Better Auth the platform's address", () => {
  const BOOTSTRAP_TOKEN = "kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk";
  const snapshot = {
    AUTH_BOOTSTRAP_TOKEN: process.env.AUTH_BOOTSTRAP_TOKEN,
    AUTH_BOOTSTRAP_ORG_NAME: process.env.AUTH_BOOTSTRAP_ORG_NAME,
  };

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    _resetBootstrapTokenForTesting();
    setPostBootstrapOrgHook(async () => {});
    setRealmResolver(async () => "platform");
    process.env.AUTH_BOOTSTRAP_TOKEN = BOOTSTRAP_TOKEN;
    process.env.AUTH_BOOTSTRAP_ORG_NAME = "Client IP HQ";
    setTrustProxy("true");
    _rebuildAuthForTesting();
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(snapshot)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    _resetCacheForTesting();
    _rebuildAuthForTesting();
    _resetBootstrapTokenForTesting();
  });

  it("records the forwarded address, not the caller's stamp, on the session", async () => {
    const res = await app.request("/api/auth/bootstrap/redeem", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Forwarded-For": "203.0.113.44",
        [CLIENT_IP_HEADER]: "198.51.100.9",
      },
      body: JSON.stringify({
        token: BOOTSTRAP_TOKEN,
        email: "owner@clientip.test",
        name: "Client IP Owner",
        password: "TestPassword123!",
      }),
    });
    expect(res.status).toBe(200);

    const [owner] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, "owner@clientip.test"));
    expect(owner).toBeDefined();
    const rows = await db
      .select({ ipAddress: session.ipAddress })
      .from(session)
      .where(eq(session.userId, owner!.id));
    expect(rows.map((r) => r.ipAddress)).toEqual(["203.0.113.44"]);
  });
});
