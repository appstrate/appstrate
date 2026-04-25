// SPDX-License-Identifier: Apache-2.0

// Integration tests for the AUTH_BOOTSTRAP_OWNER_EMAIL after-hook
// (issue #228 — Lot 4). The hook auto-creates an organization for the
// configured owner email when they sign up. Idempotent: a second signup
// (different email) does nothing; a re-signup of the same email does
// nothing (BA enforces email uniqueness anyway).

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { _resetCacheForTesting } from "@appstrate/env";
import { _rebuildAuthForTesting } from "@appstrate/db/auth";
import { getTestApp } from "../helpers/app.ts";
import { db, truncateAll } from "../helpers/db.ts";
import { organizations, organizationMembers, user } from "@appstrate/db/schema";

const app = getTestApp();

const SNAPSHOT = {
  AUTH_BOOTSTRAP_OWNER_EMAIL: process.env.AUTH_BOOTSTRAP_OWNER_EMAIL,
  AUTH_BOOTSTRAP_ORG_NAME: process.env.AUTH_BOOTSTRAP_ORG_NAME,
  AUTH_DISABLE_SIGNUP: process.env.AUTH_DISABLE_SIGNUP,
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
}

async function signUp(email: string) {
  return app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "TestPassword123!", name: "Owner" }),
  });
}

describe("Bootstrap org after-hook (AUTH_BOOTSTRAP_OWNER_EMAIL)", () => {
  beforeEach(async () => {
    await truncateAll();
    setEnv({
      AUTH_BOOTSTRAP_OWNER_EMAIL: undefined,
      AUTH_BOOTSTRAP_ORG_NAME: undefined,
      AUTH_DISABLE_SIGNUP: undefined,
    });
  });

  afterAll(() => {
    restore();
  });

  it("auto-creates the org for the bootstrap owner on signup", async () => {
    setEnv({
      AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com",
      AUTH_BOOTSTRAP_ORG_NAME: "Acme HQ",
    });

    const res = await signUp("owner@acme.com");
    expect(res.status).toBe(200);

    const [u] = await db.select().from(user).where(eq(user.email, "owner@acme.com")).limit(1);
    expect(u).toBeDefined();

    const [org] = await db.select().from(organizations).where(eq(organizations.slug, "acme-hq"));
    expect(org).toBeDefined();
    expect(org!.name).toBe("Acme HQ");

    const [membership] = await db
      .select()
      .from(organizationMembers)
      .where(eq(organizationMembers.userId, u!.id));
    expect(membership).toBeDefined();
    expect(membership!.role).toBe("owner");
    expect(membership!.orgId).toBe(org!.id);
  });

  it("works in closed mode (signup-disabled lets the bootstrap email through)", async () => {
    setEnv({
      AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com",
      AUTH_DISABLE_SIGNUP: "true",
    });

    const res = await signUp("owner@acme.com");
    expect(res.status).toBe(200);

    const [org] = await db.select().from(organizations).limit(1);
    expect(org).toBeDefined();
  });

  it("does NOT create an org for non-bootstrap signups", async () => {
    setEnv({ AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com" });

    const res = await signUp("someone-else@acme.com");
    expect(res.status).toBe(200);

    const orgCount = await db.select().from(organizations);
    expect(orgCount).toHaveLength(0);
  });

  it("falls back to slug 'default' when AUTH_BOOTSTRAP_ORG_NAME is unset", async () => {
    setEnv({ AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com" });

    const res = await signUp("owner@acme.com");
    expect(res.status).toBe(200);

    const [org] = await db.select().from(organizations).limit(1);
    expect(org).toBeDefined();
    expect(org!.slug).toBe("default");
    expect(org!.name).toBe("Default");
  });
});
