// SPDX-License-Identifier: Apache-2.0

// Integration tests for the AUTH_BOOTSTRAP_OWNER_EMAIL account (issue #228).
//
// The account at that address is born owner of the root organization, so
// creating it takes proof that the caller controls it. One test per row of
// the predicate:
//
//   address is the named owner | account exists | proof            | outcome
//   ---------------------------+----------------+------------------+---------------------------
//   yes                        | no             | none             | refused, nothing created
//   yes                        | no             | bootstrap token  | account + root org
//   yes                        | no             | verified at birth| account + root org
//   yes                        | yes            | any              | Better Auth's duplicate path
//   no                         | —              | —                | ordinary sign-up policy
//
// "none" holds whatever else would let an address through: open or closed
// sign-up, the platform-admin allowlist, a pending invitation, SMTP, realm.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { _resetCacheForTesting } from "@appstrate/env";
import { AFPS_SCHEMA_VERSION } from "@appstrate/core/validation";
import {
  _rebuildAuthForTesting,
  getAuth,
  setPostBootstrapOrgHook,
  setRealmResolver,
} from "@appstrate/db/auth";
import { getTestApp } from "../helpers/app.ts";
import { createTestContext } from "../helpers/auth.ts";
import { db, truncateAll } from "../helpers/db.ts";
import { flushRedis } from "../helpers/redis.ts";
import { seedInvitation } from "../helpers/seed.ts";
import { enableSmtpForSuite } from "../helpers/smtp.ts";
import {
  account,
  organizations,
  organizationMembers,
  user,
  spaces,
  packages,
} from "@appstrate/db/schema";
import { _resetBootstrapTokenForTesting } from "../../src/lib/bootstrap-token.ts";
import { resetRateLimiters } from "../../src/middleware/rate-limit.ts";
import { emitEvent } from "../../src/lib/modules/module-loader.ts";
import { createDefaultSpace } from "../../src/services/spaces.ts";
import { provisionDefaultAgentForOrg } from "../../src/services/default-agent.ts";

const app = getTestApp();

const VALID_TOKEN = "kZ7p_4xQm9Lr8sT2vN1wJ6yH3eC5bD0aF9oI8uP7tRk";

const SNAPSHOT = {
  AUTH_BOOTSTRAP_OWNER_EMAIL: process.env.AUTH_BOOTSTRAP_OWNER_EMAIL,
  AUTH_BOOTSTRAP_ORG_NAME: process.env.AUTH_BOOTSTRAP_ORG_NAME,
  AUTH_BOOTSTRAP_TOKEN: process.env.AUTH_BOOTSTRAP_TOKEN,
  AUTH_DISABLE_SIGNUP: process.env.AUTH_DISABLE_SIGNUP,
  AUTH_PLATFORM_ADMIN_EMAILS: process.env.AUTH_PLATFORM_ADMIN_EMAILS,
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

async function signUp(email: string) {
  return app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "TestPassword123!", name: "Owner" }),
  });
}

async function redeem(email: string, token = VALID_TOKEN) {
  return app.request("/api/auth/bootstrap/redeem", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, email, name: "Owner", password: "TestPassword123!" }),
  });
}

/** The refusal leaves no trace: no account to squat the address, no organization. */
async function expectRefusedWithNothingCreated(res: Response) {
  expect(res.status).toBe(403);
  expect(((await res.json()) as { code?: string }).code).toBe("bootstrap_owner_proof_required");
  expect(await db.select().from(user)).toHaveLength(0);
  expect(await db.select().from(organizations)).toHaveLength(0);
}

async function expectRootOrgOwnedBy(email: string, slug: string) {
  const [u] = await db.select().from(user).where(eq(user.email, email)).limit(1);
  expect(u).toBeDefined();
  const orgs = await db.select().from(organizations);
  expect(orgs).toHaveLength(1);
  expect(orgs[0]!.slug).toBe(slug);
  const [membership] = await db
    .select()
    .from(organizationMembers)
    .where(eq(organizationMembers.userId, u!.id));
  expect(membership).toMatchObject({ role: "owner", orgId: orgs[0]!.id });
}

describe("Bootstrap owner account (AUTH_BOOTSTRAP_OWNER_EMAIL)", () => {
  beforeEach(async () => {
    await truncateAll();
    _resetBootstrapTokenForTesting();
    resetRateLimiters();
    // Better Auth caps `/sign-up*` at 3 per 10s per IP and every request
    // here arrives from the same (absent) address — reset the budget so a
    // test is never throttled by the one before it.
    await flushRedis();
    setPostBootstrapOrgHook(async () => {});
    setRealmResolver(async () => "platform");
    setEnv({
      AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com",
      AUTH_BOOTSTRAP_ORG_NAME: "Acme HQ",
      AUTH_BOOTSTRAP_TOKEN: undefined,
      AUTH_DISABLE_SIGNUP: undefined,
      AUTH_PLATFORM_ADMIN_EMAILS: undefined,
    });
  });

  afterAll(() => {
    restore();
  });

  describe("without proof of ownership", () => {
    it("refuses the address when sign-up is open", async () => {
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"));
    });

    it("refuses the address when sign-up is closed", async () => {
      setEnv({ AUTH_DISABLE_SIGNUP: "true" });
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"));
    });

    it("refuses the address whatever its casing", async () => {
      await expectRefusedWithNothingCreated(await signUp("Owner@Acme.com"));
    });

    it("refuses the address when it is also a platform admin (the installer's default)", async () => {
      setEnv({ AUTH_DISABLE_SIGNUP: "true", AUTH_PLATFORM_ADMIN_EMAILS: "owner@acme.com" });
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"));
    });

    it("refuses the address when it holds a pending invitation", async () => {
      // An invitation is matched on the address alone: it lets a sign-up
      // through the closed gate, it does not show who is signing up.
      setEnv({ AUTH_BOOTSTRAP_OWNER_EMAIL: undefined });
      const inviter = await createTestContext({ orgSlug: "inviter" });
      await seedInvitation({
        orgId: inviter.orgId,
        email: "owner@acme.com",
        invitedBy: inviter.user.id,
      });
      setEnv({ AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com", AUTH_DISABLE_SIGNUP: "true" });

      const res = await signUp("owner@acme.com");
      expect(res.status).toBe(403);
      expect(await db.select().from(user).where(eq(user.email, "owner@acme.com"))).toHaveLength(0);
      expect(await db.select().from(organizations)).toHaveLength(1);
    });

    it("refuses the address in an end-user realm too", async () => {
      setRealmResolver(async () => "end_user:spc_test_space_id");
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"));
    });

    it("refuses a wrong bootstrap token", async () => {
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });
      const res = await redeem("owner@acme.com", "x".repeat(VALID_TOKEN.length));
      expect(res.status).toBe(401);
      expect(await db.select().from(user)).toHaveLength(0);
      expect(await db.select().from(organizations)).toHaveLength(0);
    });

    it("refuses the address on the sign-up form even while a token is redeemable", async () => {
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_DISABLE_SIGNUP: "true" });
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"));
    });

    it("refuses a row Better Auth is about to create unverified", async () => {
      const ctx = await getAuth().$context;
      await expect(
        ctx.internalAdapter.createUser(
          { email: "owner@acme.com", name: "Owner" },
          { method: "email-password" },
        ),
      ).rejects.toMatchObject({ body: { code: "bootstrap_owner_proof_required" } });
      expect(await db.select().from(user)).toHaveLength(0);
    });

    describe("with outbound mail configured", () => {
      enableSmtpForSuite();

      it("creates nothing: a verification mail shows who reads the inbox, not who chose the password", async () => {
        // Better Auth answers a refused sign-up like a successful one once
        // verification is required, so the status carries no signal here.
        const res = await signUp("owner@acme.com");
        expect(res.status).toBe(200);
        expect(((await res.json()) as { token: unknown }).token).toBeNull();
        expect(await db.select().from(user)).toHaveLength(0);
        expect(await db.select().from(organizations)).toHaveLength(0);
      });
    });
  });

  describe("with proof of ownership", () => {
    it("the bootstrap token creates the account and the root organization", async () => {
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_DISABLE_SIGNUP: "true" });

      const res = await redeem("owner@acme.com");
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie") ?? "").not.toBe("");
      await expectRootOrgOwnedBy("owner@acme.com", "acme-hq");
    });

    it("the token claims the named owner only", async () => {
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_DISABLE_SIGNUP: "true" });

      const res = await redeem("someone-else@acme.com");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("bootstrap_owner_email_mismatch");
      expect(await db.select().from(user)).toHaveLength(0);
      expect(await db.select().from(organizations)).toHaveLength(0);

      // The slip costs nothing: the token is still redeemable by the owner.
      expect((await redeem("owner@acme.com")).status).toBe(200);
      await expectRootOrgOwnedBy("owner@acme.com", "acme-hq");
    });

    it("a creation path that verified the inbox creates the account and the root organization", async () => {
      // What Better Auth does at the end of a magic link, and for a social
      // sign-in whose provider asserts the address: the row is born verified.
      setEnv({ AUTH_DISABLE_SIGNUP: "true" });
      const ctx = await getAuth().$context;
      await ctx.internalAdapter.createUser(
        { email: "owner@acme.com", name: "Owner", emailVerified: true },
        { method: "magic-link" },
      );
      await expectRootOrgOwnedBy("owner@acme.com", "acme-hq");
    });

    it("falls back to slug 'default' when AUTH_BOOTSTRAP_ORG_NAME is unset", async () => {
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_BOOTSTRAP_ORG_NAME: undefined });

      expect((await redeem("owner@acme.com")).status).toBe(200);
      const [org] = await db.select().from(organizations).limit(1);
      expect(org).toMatchObject({ slug: "default", name: "Default" });
    });

    it("provisions default space + hello-world agent + emits onOrgCreate, once", async () => {
      // Mirror what `boot.ts` registers in production. The preload already
      // wires this up but we re-register here with a local spy on
      // `onOrgCreate` to assert the event fired.
      const orgCreateCalls: Array<{ orgId: string; userEmail: string }> = [];
      const originalEmit = emitEvent;
      setPostBootstrapOrgHook(async ({ orgId, slug, userId, userEmail }) => {
        orgCreateCalls.push({ orgId, userEmail });
        await originalEmit("onOrgCreate", orgId, userEmail);
        const defaultSpace = await createDefaultSpace(orgId, userId);
        await provisionDefaultAgentForOrg(orgId, slug, userId, defaultSpace.id);
      });
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_BOOTSTRAP_ORG_NAME: "Acme" });

      expect((await redeem("owner@acme.com")).status).toBe(200);

      const [org] = await db.select().from(organizations).limit(1);
      expect(org).toBeDefined();

      // Default space AND the owner's personal space, both inside the org
      // transaction (`provisionOrg`, RBAC spec §3.6) — mirrors POST /api/orgs.
      const spaceRows = await db.select().from(spaces).where(eq(spaces.orgId, org!.id));
      expect(spaceRows).toHaveLength(2);
      const defaultSpaces = spaceRows.filter((row) => row.isDefault);
      expect(defaultSpaces).toHaveLength(1);
      expect(defaultSpaces[0]!.name).toBe("Default");
      expect(defaultSpaces[0]!.ownerUserId).toBeNull();
      const personal = spaceRows.filter((row) => row.ownerUserId !== null);
      expect(personal).toHaveLength(1);
      expect(personal[0]!.visibility).toBe("private");

      // hello-world agent provisioned in the org's namespace
      const orgPackages = await db.select().from(packages).where(eq(packages.orgId, org!.id));
      const helloWorld = orgPackages.find((p) => p.id === `@${org!.slug}/hello-world`);
      expect(helloWorld).toBeDefined();
      expect(helloWorld!.draftManifest).toMatchObject({ schema_version: AFPS_SCHEMA_VERSION });

      // The sign-up hook and the redeem route both reach for the org; the
      // fan-out still fires exactly once.
      expect(orgCreateCalls).toEqual([{ orgId: org!.id, userEmail: "owner@acme.com" }]);
    });

    it("does not provision a platform org for an end-user realm row", async () => {
      setRealmResolver(async () => "end_user:spc_test_space_id");
      const ctx = await getAuth().$context;
      await ctx.internalAdapter.createUser(
        { email: "owner@acme.com", name: "Owner", emailVerified: true },
        { method: "magic-link" },
      );

      const [u] = await db.select().from(user).where(eq(user.email, "owner@acme.com")).limit(1);
      expect(u!.realm).toBe("end_user:spc_test_space_id");
      expect(await db.select().from(organizations)).toHaveLength(0);
    });
  });

  describe("when the account already exists", () => {
    it("a sign-up neither sets a password on it nor creates an organization", async () => {
      // The account as a social sign-in leaves it: a user row, no password.
      await db.insert(user).values({
        id: "usr_existing_owner",
        email: "owner@acme.com",
        name: "Owner",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const res = await getAuth().api.signUpEmail({
        body: { email: "owner@acme.com", password: "TestPassword123!", name: "Owner" },
        asResponse: true,
      });
      expect(res.status).toBe(422);
      expect(await db.select().from(account)).toHaveLength(0);
      expect(await db.select().from(organizations)).toHaveLength(0);
    });

    it("a second claim with the token is refused once the owner exists", async () => {
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });
      expect((await redeem("owner@acme.com")).status).toBe(200);
      expect((await redeem("owner@acme.com")).status).toBe(410);
      expect(await db.select().from(user)).toHaveLength(1);
    });
  });

  describe("any other address", () => {
    it("signs up without getting an organization", async () => {
      const res = await signUp("someone-else@acme.com");
      expect(res.status).toBe(200);
      expect(await db.select().from(organizations)).toHaveLength(0);
    });

    it("is untouched when no owner is named", async () => {
      setEnv({ AUTH_BOOTSTRAP_OWNER_EMAIL: undefined });
      const res = await signUp("owner@acme.com");
      expect(res.status).toBe(200);
      expect(await db.select().from(organizations)).toHaveLength(0);
    });
  });
});
