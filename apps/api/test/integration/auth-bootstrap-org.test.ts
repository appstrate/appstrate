// SPDX-License-Identifier: Apache-2.0

// Integration tests for the AUTH_BOOTSTRAP_OWNER_EMAIL after-hook
// (issue #228 — Lot 4). The hook auto-creates an organization for the
// configured owner email when they sign up. Idempotent: a second signup
// (different email) does nothing; a re-signup of the same email does
// nothing (BA enforces email uniqueness anyway).

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
import {
  organizations,
  organizationMembers,
  user,
  applications,
  packages,
} from "@appstrate/db/schema";
import { emitEvent } from "../../src/lib/modules/module-loader.ts";
import { createDefaultApplication } from "../../src/services/applications.ts";
import { provisionDefaultAgentForOrg } from "../../src/services/default-agent.ts";

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

  it("provisions default application + hello-world agent + emits onOrgCreate", async () => {
    // Mirror what `boot.ts` registers in production. The preload already
    // wires this up but we re-register here with a local spy on
    // `onOrgCreate` to assert the event fired.
    const orgCreateCalls: Array<{ orgId: string; userEmail: string }> = [];
    const originalEmit = emitEvent;
    setPostBootstrapOrgHook(async ({ orgId, slug, userId, userEmail }) => {
      orgCreateCalls.push({ orgId, userEmail });
      await originalEmit("onOrgCreate", orgId, userEmail);
      const defaultApp = await createDefaultApplication(orgId, userId);
      await provisionDefaultAgentForOrg(orgId, slug, userId, defaultApp.id);
    });

    setEnv({
      AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com",
      AUTH_BOOTSTRAP_ORG_NAME: "Acme",
    });

    const res = await signUp("owner@acme.com");
    expect(res.status).toBe(200);

    const [org] = await db.select().from(organizations).limit(1);
    expect(org).toBeDefined();

    // Default application created (mirrors POST /api/orgs)
    const apps = await db.select().from(applications).where(eq(applications.orgId, org!.id));
    expect(apps).toHaveLength(1);
    expect(apps[0]!.isDefault).toBe(true);
    expect(apps[0]!.name).toBe("Default");

    // hello-world agent provisioned in the org's namespace
    const orgPackages = await db.select().from(packages).where(eq(packages.orgId, org!.id));
    expect(orgPackages.length).toBeGreaterThanOrEqual(1);
    expect(orgPackages.some((p) => p.id === `@${org!.slug}/hello-world`)).toBe(true);

    // onOrgCreate fan-out fired exactly once
    expect(orgCreateCalls).toHaveLength(1);
    expect(orgCreateCalls[0]).toMatchObject({
      orgId: org!.id,
      userEmail: "owner@acme.com",
    });
  });

  it("does NOT bootstrap for non-platform realm signups (OIDC end-user flow)", async () => {
    // Simulate an OIDC end-user signup by overriding the realm resolver
    // to return the application-level realm string. The bootstrap email
    // would otherwise match — the realm guard is what stops it.
    setRealmResolver(async () => "end_user:app_test_application_id");
    try {
      setEnv({
        AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com",
        AUTH_BOOTSTRAP_ORG_NAME: "Acme",
      });

      const res = await signUp("owner@acme.com");
      expect(res.status).toBe(200);

      // User exists with the end-user realm
      const [u] = await db.select().from(user).where(eq(user.email, "owner@acme.com")).limit(1);
      expect(u).toBeDefined();
      expect(u!.realm).toBe("end_user:app_test_application_id");

      // No platform org provisioned for them
      const orgCount = await db.select().from(organizations);
      expect(orgCount).toHaveLength(0);
    } finally {
      // Restore the default resolver (returns "platform") for subsequent tests.
      setRealmResolver(async () => "platform");
    }
  });
});
