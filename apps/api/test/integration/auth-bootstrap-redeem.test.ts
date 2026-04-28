// SPDX-License-Identifier: Apache-2.0

// Integration tests for `POST /api/auth/bootstrap/redeem` (#344 Layer 2b).
//
// Exercises the full chain: timing-safe token compare, AsyncLocalStorage
// signup-gate bypass, BA programmatic signup, bootstrap-org creation,
// in-memory consume flag, and the durable DB-org-count replay guard.
//
// Mirrors the env-toggle pattern from `auth-bootstrap-org.test.ts` so
// the two suites can run side-by-side without state leakage.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { _resetCacheForTesting } from "@appstrate/env";
import {
  _rebuildAuthForTesting,
  setPostBootstrapOrgHook,
  setRealmResolver,
} from "@appstrate/db/auth";
import { getTestApp } from "../helpers/app.ts";
import { db, truncateAll } from "../helpers/db.ts";
import { organizations, organizationMembers, user } from "@appstrate/db/schema";
import { _resetBootstrapTokenForTesting } from "../../src/lib/bootstrap-token.ts";
import { resetRateLimiters } from "../../src/middleware/rate-limit.ts";
import { flushRedis } from "../helpers/redis.ts";

const app = getTestApp();

const VALID_TOKEN = "kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk";

const SNAPSHOT = {
  AUTH_BOOTSTRAP_TOKEN: process.env.AUTH_BOOTSTRAP_TOKEN,
  AUTH_BOOTSTRAP_ORG_NAME: process.env.AUTH_BOOTSTRAP_ORG_NAME,
  AUTH_DISABLE_SIGNUP: process.env.AUTH_DISABLE_SIGNUP,
  AUTH_DISABLE_ORG_CREATION: process.env.AUTH_DISABLE_ORG_CREATION,
  AUTH_ALLOWED_SIGNUP_DOMAINS: process.env.AUTH_ALLOWED_SIGNUP_DOMAINS,
};

function setEnv(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetCacheForTesting();
  _rebuildAuthForTesting();
}

function restore() {
  for (const [k, v] of Object.entries(SNAPSHOT)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  _resetCacheForTesting();
  _rebuildAuthForTesting();
  _resetBootstrapTokenForTesting();
}

async function redeem(body: Record<string, unknown>) {
  return app.request("/api/auth/bootstrap/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/bootstrap/redeem", () => {
  beforeEach(async () => {
    await truncateAll();
    _resetBootstrapTokenForTesting();
    // Fresh rate-limit budget per test — clear both the in-process
    // limiter cache AND the Redis-backed counters so tests using >5
    // calls (parallel-redeem, second-redeem, domain-allowlist) don't
    // accumulate consumption across cases.
    resetRateLimiters();
    await flushRedis();
    // Wire the post-hook so the redeem route has a destination for its
    // best-effort default-app provisioning. We don't assert on it here
    // (covered in auth-bootstrap-org.test.ts) — we just need it not to
    // be a no-op that hides a regression in the default path.
    setPostBootstrapOrgHook(async () => {});
    setRealmResolver(async () => "platform");
    setEnv({
      AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN,
      AUTH_DISABLE_SIGNUP: "true",
      AUTH_DISABLE_ORG_CREATION: "true",
      AUTH_BOOTSTRAP_ORG_NAME: "Acme HQ",
      // Explicit reset so the domain-allowlist test doesn't leak its
      // setting into subsequent test cases.
      AUTH_ALLOWED_SIGNUP_DOMAINS: undefined,
    });
  });

  afterAll(() => {
    restore();
  });

  it("happy path — valid token + signup data → 200, owner + org created, session set", async () => {
    const res = await redeem({
      token: VALID_TOKEN,
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bootstrap?: { orgId: string; orgSlug: string } };
    expect(body.bootstrap).toBeDefined();
    expect(body.bootstrap!.orgSlug).toBe("acme-hq");

    // BA session cookie must be set so the SPA's hard-reload to / lands
    // authenticated. BA names it `better-auth.session_token` by default.
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie.length).toBeGreaterThan(0);

    // User row exists.
    const [u] = await db.select().from(user).where(eq(user.email, "owner@acme.com")).limit(1);
    expect(u).toBeDefined();

    // Org + owner membership.
    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "acme-hq"));
    expect(org).toBeDefined();
    const [membership] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, u!.id));
    expect(membership).toBeDefined();
    expect(membership!.role).toBe("owner");
    expect(membership!.orgId).toBe(org!.id);
  });

  it("rejects malformed body — missing token", async () => {
    const res = await redeem({
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed body — short password", async () => {
    const res = await redeem({
      token: VALID_TOKEN,
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "tiny",
    });
    expect(res.status).toBe(400);
  });

  it("rejects bad token with 401 (timing-safe compare)", async () => {
    const res = await redeem({
      token: "definitely-not-the-right-token",
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    expect(res.status).toBe(401);
    // No user/org should have been created.
    const u = await db.select().from(user);
    expect(u).toHaveLength(0);
    const orgs = await db.select().from(organizations);
    expect(orgs).toHaveLength(0);
  });

  it("returns 410 when no token is configured", async () => {
    setEnv({ AUTH_BOOTSTRAP_TOKEN: undefined });
    _resetBootstrapTokenForTesting();
    const res = await redeem({
      token: VALID_TOKEN,
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    expect(res.status).toBe(410);
  });

  it("returns 410 when an org already exists (durable replay guard)", async () => {
    // Pre-seed an org so the DB-org-count gate trips even without the
    // in-memory consume flag (simulates a process restart after a prior
    // redemption).
    await db.insert(organizations).values({
      name: "Pre-existing",
      slug: "pre-existing",
      createdBy: null,
    });
    const res = await redeem({
      token: VALID_TOKEN,
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    expect(res.status).toBe(410);
  });

  it("returns 410 on second redemption (in-memory consume flag)", async () => {
    const ok = await redeem({
      token: VALID_TOKEN,
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    expect(ok.status).toBe(200);
    const replay = await redeem({
      token: VALID_TOKEN,
      email: "another@acme.com",
      name: "Another",
      password: "TestPassword123!",
    });
    expect(replay.status).toBe(410);
  });

  it("returns 409 when the email is already taken (rare race / replay attempt)", async () => {
    // First redeem succeeds.
    await redeem({
      token: VALID_TOKEN,
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    // Reset the consume flag + truncate orgs so the redeem path is
    // reachable again, but leave the user row in place. The duplicate
    // email collision should surface as a 4xx.
    _resetBootstrapTokenForTesting();
    await db.delete(organizations);
    const res = await redeem({
      token: VALID_TOKEN,
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    // BA returns 422 for duplicate email; our route either surfaces
    // that or remaps to 409 depending on the message shape. Both are
    // valid 4xx — assert "client error" not the exact code.
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  // Audit fix: parallel redeems must not both create owners. The CAS
  // (`tryAcquireRedemption`) + advisory lock (`pg_try_advisory_lock`)
  // together guarantee that only one of two simultaneous POSTs reaches
  // the signUpEmail path — the loser sees 409 (in-flight) or 410
  // (token already consumed by the winner).
  it("serializes parallel redeems — only one creates an org", async () => {
    const [resA, resB] = await Promise.all([
      redeem({
        token: VALID_TOKEN,
        email: "winner@acme.com",
        name: "Winner",
        password: "TestPassword123!",
      }),
      redeem({
        token: VALID_TOKEN,
        email: "loser@acme.com",
        name: "Loser",
        password: "TestPassword123!",
      }),
    ]);

    const sorted = [resA.status, resB.status].sort((a, b) => a - b);
    // Exactly one should succeed (200); the other must be 409 (in
    // flight) or 410 (consumed) depending on which check intercepted.
    expect(sorted[0]).toBe(200);
    expect([409, 410]).toContain(sorted[1]!);

    const orgs = await db.select().from(organizations);
    expect(orgs).toHaveLength(1);

    const users = await db.select().from(user);
    expect(users).toHaveLength(1);
  });

  // Audit fix: bootstrap-token bypass is scoped to AUTH_DISABLE_SIGNUP
  // ONLY. An active domain allowlist remains load-bearing — the operator
  // chose to lock down which emails can register, and the bypass must
  // not silently skip that policy.
  it("respects AUTH_ALLOWED_SIGNUP_DOMAINS during redemption", async () => {
    setEnv({
      AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN,
      AUTH_DISABLE_SIGNUP: "true",
      AUTH_DISABLE_ORG_CREATION: "true",
      AUTH_BOOTSTRAP_ORG_NAME: "Acme HQ",
      AUTH_ALLOWED_SIGNUP_DOMAINS: "acme.com",
    });

    // Off-domain email must be rejected (403 surface from the redeem
    // route remap, or 4xx from BA — either way, NOT 200).
    const denied = await redeem({
      token: VALID_TOKEN,
      email: "owner@evil.com",
      name: "Evil Owner",
      password: "TestPassword123!",
    });
    expect(denied.status).toBeGreaterThanOrEqual(400);
    expect(denied.status).toBeLessThan(500);

    // No user/org should have been created.
    expect(await db.select().from(user)).toHaveLength(0);
    expect(await db.select().from(organizations)).toHaveLength(0);

    // Allowed-domain email succeeds.
    const allowed = await redeem({
      token: VALID_TOKEN,
      email: "owner@acme.com",
      name: "Acme Owner",
      password: "TestPassword123!",
    });
    expect(allowed.status).toBe(200);
  });
});
