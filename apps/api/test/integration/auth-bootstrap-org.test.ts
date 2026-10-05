// SPDX-License-Identifier: Apache-2.0

// Integration tests for the AUTH_BOOTSTRAP_OWNER_EMAIL account (issue #228).
//
// The account at that address is born owner of the root organization, so
// creating it takes proof that the caller controls it. One test per row of
// the predicate:
//
//   address is the named owner | account exists | how it is acquired | outcome
//   ---------------------------+----------------+--------------------+---------------------------
//   yes                        | no             | sign-up, no proof  | refused, nothing created
//   yes                        | no             | e-mail change      | refused, row unchanged
//   yes                        | no             | bootstrap token    | account + root org
//   yes                        | no             | verified at birth  | account + root org
//   yes                        | yes            | sign-up / token    | refused, account untouched
//   no                         | —              | —                  | ordinary sign-up policy
//
// "no proof" holds whatever else would let an address through: open or closed
// sign-up, the platform-admin allowlist, a pending invitation, SMTP, realm.
// A refusal reads like the one any other address gets in the same mode.

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
  verification,
  organizations,
  organizationMembers,
  user,
  spaces,
  packages,
} from "@appstrate/db/schema";
import {
  _resetBootstrapTokenForTesting,
  isBootstrapTokenPending,
} from "../../src/lib/bootstrap-token.ts";
import { triggerPostBootstrapOrg } from "../../src/lib/post-bootstrap-hook.ts";
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

type Refusal = { status: number; code: string };
const TAKEN: Refusal = { status: 422, code: "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL" };
const CLOSED: Refusal = { status: 403, code: "signup_disabled" };

/** The refusal leaves no trace: no account to squat the address, no organization. */
async function expectRefusedWithNothingCreated(res: Response, as: Refusal) {
  expect(res.status).toBe(as.status);
  expect(((await res.json()) as { code?: string }).code).toBe(as.code);
  expect(await db.select().from(user)).toHaveLength(0);
  expect(await db.select().from(organizations)).toHaveLength(0);
}

/** Sign up through the real route and keep the session it opens. */
async function signedUpSession(email: string): Promise<string> {
  const res = await signUp(email);
  expect(res.status).toBe(200);
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

async function changeEmail(cookie: string, newEmail: string) {
  return app.request("/api/auth/change-email", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ newEmail }),
  });
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
      AUTH_ALLOWED_SIGNUP_DOMAINS: undefined,
    });
  });

  afterAll(() => {
    restore();
  });

  describe("without proof of ownership", () => {
    it("refuses the address when sign-up is open, as it refuses a taken address", async () => {
      const res = await signUp("owner@acme.com");
      const body = await res.clone().text();
      await expectRefusedWithNothingCreated(res, TAKEN);

      // Byte for byte what Better Auth answers for an address that IS taken,
      // so a Better Auth upgrade that rewords one cannot leave them apart.
      expect((await signUp("someone@acme.com")).status).toBe(200);
      const taken = await signUp("someone@acme.com");
      expect(taken.status).toBe(422);
      expect(await taken.text()).toBe(body);
    });

    it("refuses the address when sign-up is closed, as it refuses a stranger", async () => {
      setEnv({ AUTH_DISABLE_SIGNUP: "true" });
      const res = await signUp("owner@acme.com");
      const body = await res.clone().text();
      await expectRefusedWithNothingCreated(res, CLOSED);
      expect(await (await signUp("stranger@acme.com")).text()).toBe(body);
    });

    it("refuses the address as a disallowed domain when the allowlist excludes it", async () => {
      setEnv({ AUTH_ALLOWED_SIGNUP_DOMAINS: "elsewhere.test" });
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"), {
        status: 403,
        code: "signup_domain_not_allowed",
      });
    });

    it("refuses the address whatever its casing", async () => {
      await expectRefusedWithNothingCreated(await signUp("Owner@Acme.com"), TAKEN);
    });

    it("refuses the address when it is also a platform admin (the installer's default)", async () => {
      setEnv({ AUTH_DISABLE_SIGNUP: "true", AUTH_PLATFORM_ADMIN_EMAILS: "owner@acme.com" });
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"), CLOSED);
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
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"), TAKEN);
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
      await expectRefusedWithNothingCreated(await signUp("owner@acme.com"), CLOSED);
    });

    it("refuses a row Better Auth is about to create unverified", async () => {
      const ctx = await getAuth().$context;
      await expect(
        ctx.internalAdapter.createUser(
          { email: "owner@acme.com", name: "Owner" },
          { method: "email-password" },
        ),
      ).rejects.toMatchObject({ body: { code: TAKEN.code } });
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

  describe("by changing an existing account's e-mail", () => {
    it("refuses to move an account onto the owner's address, and the token still claims it", async () => {
      setEnv({ AUTH_BOOTSTRAP_OWNER_EMAIL: undefined });
      const cookie = await signedUpSession("member@acme.com");
      setEnv({ AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com", AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });

      const res = await changeEmail(cookie, "owner@acme.com");
      expect(res.status).toBe(403);
      expect(((await res.json()) as { code?: string }).code).toBe("email_change_refused");
      expect((await db.select().from(user)).map((u) => u.email)).toEqual(["member@acme.com"]);
      expect(await db.select().from(organizations)).toHaveLength(0);

      expect((await redeem("owner@acme.com")).status).toBe(200);
      await expectRootOrgOwnedBy("owner@acme.com", "acme-hq");
    });

    it("refuses to move an account onto a platform admin's address", async () => {
      const cookie = await signedUpSession("member@acme.com");
      setEnv({ AUTH_PLATFORM_ADMIN_EMAILS: "ops@acme.com" });

      const res = await changeEmail(cookie, "Ops@Acme.com");
      expect(res.status).toBe(403);
      expect((await db.select().from(user)).map((u) => u.email)).toEqual(["member@acme.com"]);
    });

    it("still lets an account move to an ordinary address", async () => {
      // The control: without it the two refusals above prove nothing about
      // the rule, only that the route answers 403.
      const cookie = await signedUpSession("member@acme.com");
      setEnv({ AUTH_PLATFORM_ADMIN_EMAILS: "ops@acme.com" });

      expect((await changeEmail(cookie, "renamed@acme.com")).status).toBe(200);
      expect((await db.select().from(user)).map((u) => u.email)).toEqual(["renamed@acme.com"]);
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

    it("the token claims a named owner outside AUTH_ALLOWED_SIGNUP_DOMAINS", async () => {
      // The operator named that address; the allowlist is for everybody else.
      setEnv({
        AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN,
        AUTH_DISABLE_SIGNUP: "true",
        AUTH_ALLOWED_SIGNUP_DOMAINS: "elsewhere.test",
      });
      expect((await redeem("owner@acme.com")).status).toBe(200);
      await expectRootOrgOwnedBy("owner@acme.com", "acme-hq");
    });

    describe("a magic link sent to the address", () => {
      enableSmtpForSuite();

      it("creates the account and the root organization, and retires the token", async () => {
        // Through Better Auth's own routes, so the row is born verified
        // because the link was consumed and not because a test said so.
        setPostBootstrapOrgHook(triggerPostBootstrapOrg);
        setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_DISABLE_SIGNUP: "true" });
        expect(isBootstrapTokenPending()).toBe(true);

        const sent = await app.request("/api/auth/sign-in/magic-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "owner@acme.com" }),
        });
        expect(sent.status).toBe(200);
        const [link] = await db.select().from(verification);
        expect(link).toBeDefined();

        const verified = await app.request(
          `/api/auth/magic-link/verify?token=${encodeURIComponent(link!.identifier)}`,
        );
        expect(verified.status).toBeLessThan(400);

        await expectRootOrgOwnedBy("owner@acme.com", "acme-hq");
        const [u] = await db.select().from(user);
        expect(u!.emailVerified).toBe(true);
        expect(await db.select().from(account)).toHaveLength(0);
        // Nobody redeemed it, and `/claim` must not stay the only page shown.
        expect(isBootstrapTokenPending()).toBe(false);
        expect((await redeem("owner@acme.com")).status).toBe(410);
      });
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
      // Hand-set `emailVerified`: only the realm guard of the after-hook is
      // under test here. The proof itself is driven through the magic-link
      // routes above.
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

    it("the token says so instead of taking the account over", async () => {
      await db.insert(user).values({
        id: "usr_existing_owner",
        email: "owner@acme.com",
        name: "Owner",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });

      const res = await redeem("owner@acme.com");
      expect(res.status).toBe(409);
      const problem = (await res.json()) as { code?: string; detail?: string };
      expect(problem.code).toBe("bootstrap_user_exists");
      expect(problem.detail).toContain("bootstrap-org.ts");
      expect(await db.select().from(account)).toHaveLength(0);
      expect(await db.select().from(organizations)).toHaveLength(0);
    });

    describe("with outbound mail configured", () => {
      enableSmtpForSuite();

      it("the token still does not make the existing account owner", async () => {
        // Better Auth answers a duplicate sign-up with a synthetic success
        // here, which the route used to read as "account created".
        await db.insert(user).values({
          id: "usr_existing_owner",
          email: "owner@acme.com",
          name: "Owner",
          emailVerified: true,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
        setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });

        expect((await redeem("owner@acme.com")).status).toBe(409);
        expect(await db.select().from(organizations)).toHaveLength(0);
      });
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
