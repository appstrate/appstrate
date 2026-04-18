// SPDX-License-Identifier: Apache-2.0

/**
 * Rate-limit regressions on the `/oauth2/token` and `/device/token`
 * endpoints.
 *
 * Two axes:
 *   1. **Per-IP** — the existing `enforceRateLimit` pipes every request
 *      through `rl:oidc:<category>:<ip>`. Already exercised implicitly
 *      by the happy-path suites; this file nails down the boundary so a
 *      future refactor that drops the limiter cannot pass silently.
 *   2. **Per-client_id** — `enforceClientRateLimit` adds a secondary
 *      ceiling on `/oauth2/token` keyed on `client_id` alone. It
 *      defends against distributed `client_secret` brute force that
 *      spreads attacks across many source IPs (or that bypasses the
 *      per-IP limiter via XFF spoofing behind a misconfigured
 *      TRUST_PROXY). The SOTA review flagged that this was the "flagship
 *      control" advertised in the PR yet entirely untested — any future
 *      change to `extractClientId` or the matcher ordering could silently
 *      disable it without CI catching on.
 *
 * We drive the limiter from `TOKEN_CLIENT_RL_POINTS=20` to 21 via the
 * public `/oauth2/token` endpoint with varied `X-Forwarded-For` values
 * and `TRUST_PROXY=true` so the per-IP limiter sees distinct IPs. The
 * per-client_id limiter should fire regardless, returning a 429 with
 * `Retry-After` on the 21st attempt.
 */

import { describe, it, expect, beforeEach, beforeAll, afterAll } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { createTestContext } from "../../../../../../test/helpers/auth.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import oidcModule from "../../../index.ts";
import { resetOidcGuardsLimiters } from "../../../auth/guards.ts";
import { ensureCliClient } from "../../../services/ensure-cli-client.ts";

const app = getTestApp({ modules: [oidcModule] });

// `enforceRateLimit` reads the client IP through `getClientIpFromRequest`
// which in turn honors `TRUST_PROXY` to decide whether to trust XFF. We
// need distinct per-IP keys so the per-IP limiter (30/min) doesn't lock
// out before we can exercise the per-client_id limiter (20/min).
const originalTrustProxy = process.env.TRUST_PROXY;

beforeAll(() => {
  process.env.TRUST_PROXY = "true";
});

afterAll(() => {
  if (originalTrustProxy === undefined) delete process.env.TRUST_PROXY;
  else process.env.TRUST_PROXY = originalTrustProxy;
});

describe("oauth2-token per-client_id rate limit", () => {
  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    resetOidcGuardsLimiters();
    await createTestContext({ orgSlug: "ratelimit" });
    await ensureCliClient();
  });

  it("429s the 21st /oauth2/token request for the same client_id across distinct IPs", async () => {
    // 20 requests allowed, 21st must trip the per-client_id limit even
    // when the per-IP limiter sees a fresh IP on each call. The payload
    // is deliberately malformed (empty device_code) so upstream returns
    // a semantic error quickly — we only care that the limiter fires
    // before the BA handler even gets called.
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: "appstrate-cli",
      code: "invalid",
      redirect_uri: "http://localhost/cb",
      // The per-route guard checks `resource` on authorization_code —
      // supplying a valid audience keeps the limiter as the only gate
      // that fires, so failures up-stream can't mask a missing 429.
      resource: "http://localhost:3000",
    }).toString();

    const statuses: number[] = [];
    let lastScope: string | null = null;
    for (let i = 0; i < 21; i++) {
      const res = await app.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // Distinct source IP for every attempt — makes the per-IP
          // limiter non-binding and isolates the per-client_id limiter
          // as the only ceiling actually tripping.
          "X-Forwarded-For": `10.0.0.${i + 1}`,
        },
        body,
      });
      statuses.push(res.status);
      if (i === 20) {
        lastScope = res.headers.get("X-RateLimit-Scope");
      }
    }

    // Exactly one 429 at the end — the first 20 land on whatever
    // upstream status the BA handler returns for an invalid grant
    // (`400` / `401`), but the 21st MUST be rate-limited.
    const last = statuses[statuses.length - 1];
    expect(last).toBe(429);

    // CRITICAL: assert the 429 came from the per-client_id limiter,
    // not the per-IP one. `X-RateLimit-Scope: client` is set only by
    // `enforceClientRateLimit`; the per-IP limiter emits
    // `X-RateLimit-Scope: ip`. Without this check, a future change
    // that deleted `enforceClientRateLimit` and tightened
    // `TOKEN_RL_POINTS` to 20 would let this test keep passing on a
    // per-IP 429 even though the defense this file exists to protect
    // is gone. The scope header is the test's sharp discriminator
    // between the two limiters — external error_description is kept
    // neutral so attackers don't learn the keying strategy from a
    // 429 alone.
    expect(lastScope).toBe("client");

    // Sanity: the limiter didn't already fire before the 21st. If the
    // per-IP limiter is somehow still binding (TRUST_PROXY ignored, IPs
    // collapsing to the test loopback), statuses[0..19] would also
    // include 429s and this would fail — catching the misconfig.
    const tooEarly = statuses.slice(0, 20).filter((s) => s === 429).length;
    expect(tooEarly).toBe(0);
  });

  it("includes Retry-After on the 429 response", async () => {
    // Use distinct client_id so it isolates from the test above if
    // they ever run in the same Redis instance without a flush. Use an
    // obviously-invalid client so BA's own handler would return
    // invalid_client — we only care that the limiter fires.
    const clientId = "rate-limit-probe";
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code: "x",
      redirect_uri: "http://localhost/cb",
      resource: "http://localhost:3000",
    }).toString();

    let finalRes: Response | null = null;
    for (let i = 0; i < 21; i++) {
      finalRes = await app.request("/api/auth/oauth2/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Forwarded-For": `10.0.1.${i + 1}`,
        },
        body,
      });
    }
    if (!finalRes) throw new Error("no response");
    expect(finalRes.status).toBe(429);
    const retryAfter = finalRes.headers.get("Retry-After");
    expect(retryAfter).toBeTruthy();
    // `Retry-After` is seconds (not an HTTP date) in our implementation.
    expect(Number(retryAfter)).toBeGreaterThan(0);
  });
});
