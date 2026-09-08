// SPDX-License-Identifier: Apache-2.0

/**
 * Rate limits on `/oauth2/token` and on BA's `GET /device?user_code=…` probe.
 *
 * Both budgets belong to Better Auth: the oauth-provider declares its own
 * (`oauthProvider({ rateLimit })` in `auth/plugins.ts` — token 20 per 60 s)
 * and `deviceAuthorization()` declares 5 probes per `expiresIn`. Better Auth
 * enforces them in `onRequest`, before any plugin `before` hook runs, against
 * the platform's shared limiter (`infra/rate-limit/better-auth-storage.ts`),
 * and keys each bucket on the client IP the platform resolved
 * (`lib/client-ip.ts`) — so `TRUST_PROXY` decides whether a forwarded chain
 * buys a caller its own budget. Refusals carry `X-Retry-After`, not the
 * `Retry-After` the local device/CLI limiters emit.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { resetClientIpCache } from "../../../../../lib/client-ip.ts";
import { _resetCacheForTesting } from "@appstrate/env";
import oidcModule from "../../../index.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";

const app = getTestApp({ modules: [oidcModule] });

/** `oauthProvider({ rateLimit: { token: { window: 60, max: 20 } } })`. */
const TOKEN_MAX = 20;
/** `deviceAuthorization({ ... })`'s own `max: 5` on the user_code probe. */
const DEVICE_PROBE_MAX = 5;

// The forwarded chain only reaches the limiter when the platform trusts it,
// and `@appstrate/env` caches its parse — both caches have to be dropped for
// the new value to take, in each direction.
const originalTrustProxy = process.env.TRUST_PROXY;

beforeAll(() => {
  process.env.TRUST_PROXY = "true";
  _resetCacheForTesting();
  resetClientIpCache();
});

afterAll(() => {
  if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = originalTrustProxy;
  _resetCacheForTesting();
  resetClientIpCache();
});

/**
 * One `/oauth2/token` exchange from `ip`. The grant is deliberately invalid —
 * the limiter runs before the handler, so the upstream rejection status is
 * irrelevant and only "429 or not" is asserted.
 */
async function postToken(ip: string): Promise<Response> {
  return app.request("/api/auth/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-Forwarded-For": ip,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "appstrate-cli",
      code: "invalid",
      redirect_uri: "http://localhost/cb",
      resource: "http://localhost:3000",
    }).toString(),
  });
}

async function spendTokenBudget(ip: string): Promise<void> {
  for (let i = 0; i < TOKEN_MAX; i++) {
    expect((await postToken(ip)).status).not.toBe(429);
  }
}

describe("oauth2-token rate limit", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    await createTestContext({ orgSlug: "ratelimit" });
    await ensureCliClient();
  });

  it("429s the request past the budget for one forwarded client IP", async () => {
    await spendTokenBudget("203.0.113.10");

    const refused = await postToken("203.0.113.10");
    expect(refused.status).toBe(429);

    // Better Auth answers `X-Retry-After` in seconds — the local device/CLI
    // limiters are the ones emitting `Retry-After`.
    const retryAfter = Number(refused.headers.get("X-Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThan(0);
  });

  it("gives a different forwarded client IP its own budget", async () => {
    await spendTokenBudget("203.0.113.10");
    expect((await postToken("203.0.113.10")).status).toBe(429);

    // Which only holds if the address the limiter keyed on is the one the
    // platform resolved from the forwarded chain, not the socket peer every
    // request in this suite shares.
    expect((await postToken("203.0.113.11")).status).not.toBe(429);
  });

  it("429s the 6th GET /device user_code probe from the same IP", async () => {
    // `GET /device?user_code=…` (mounted by `deviceAuthorization()`) is
    // public, no auth, and returns the row's `status` for any matching
    // user_code — an enumeration surface over the ~34.6-bit user_code
    // space. The happy path never spends the budget: the `/activate` consent
    // page reads the row through the in-process `deviceVerify()` API.
    const statuses: number[] = [];
    for (let i = 0; i < DEVICE_PROBE_MAX + 1; i++) {
      const res = await app.request(`/api/auth/device?user_code=BOGUS-${i}`, {
        method: "GET",
        headers: { "X-Forwarded-For": "10.0.99.1" },
      });
      statuses.push(res.status);
    }

    // First 5 reach BA (which 400s on an unknown code); the 6th is refused.
    expect(statuses[statuses.length - 1]).toBe(429);
    expect(statuses.slice(0, DEVICE_PROBE_MAX).filter((s) => s === 429)).toHaveLength(0);
  });
});
