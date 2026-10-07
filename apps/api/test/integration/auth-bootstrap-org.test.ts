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
//
// An address listed in AUTH_PLATFORM_ADMIN_EMAILS is created under the same
// proof rule (it gets no organization): the "no proof" rows run over both
// kinds of named address.

import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { eq } from "drizzle-orm";
import { APIError } from "better-auth/api";
import { AFPS_SCHEMA_VERSION } from "@appstrate/core/validation";
import {
  getAuth,
  setBeforeSignupHook,
  setPostBootstrapOrgHook,
  setRealmResolver,
} from "@appstrate/db/auth";
import { getTestApp } from "../helpers/app.ts";
import {
  captureIssuedMagicLinks,
  createTestContext,
  restoreBeforeSignupHookAfterSuite,
  restorePostBootstrapOrgHookAfterSuite,
  restoreRealmResolverAfterSuite,
} from "../helpers/auth.ts";
import { useAuthEnv } from "../helpers/auth-env.ts";
import { db, truncateAll } from "../helpers/db.ts";
import { flushRedis } from "../helpers/redis.ts";
import { seedInvitation } from "../helpers/seed.ts";
import { captureMails, enableSmtpForSuite } from "../helpers/smtp.ts";
import {
  account,
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

const setEnv = useAuthEnv();

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

const UNNAMED = { AUTH_BOOTSTRAP_OWNER_EMAIL: undefined, AUTH_PLATFORM_ADMIN_EMAILS: undefined };

/** The two ways the environment names an address; both take proof to create. */
const NAMED_ADDRESSES = [
  {
    kind: "the bootstrap owner",
    address: "owner@acme.com",
    cased: "Owner@Acme.com",
    naming: { ...UNNAMED, AUTH_BOOTSTRAP_OWNER_EMAIL: "owner@acme.com" },
  },
  {
    kind: "a platform admin",
    address: "ops@acme.com",
    cased: "Ops@Acme.com",
    naming: { ...UNNAMED, AUTH_PLATFORM_ADMIN_EMAILS: "ops@acme.com" },
  },
];

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

restoreRealmResolverAfterSuite();
restorePostBootstrapOrgHookAfterSuite();
restoreBeforeSignupHookAfterSuite();

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
      AUTH_DISABLE_ORG_CREATION: undefined,
      AUTH_PLATFORM_ADMIN_EMAILS: undefined,
      AUTH_ALLOWED_SIGNUP_DOMAINS: undefined,
    });
  });

  afterAll(() => {
    _resetBootstrapTokenForTesting();
  });

  for (const { kind, address, cased, naming } of NAMED_ADDRESSES) {
    describe(`without proof of ownership, ${kind}`, () => {
      beforeEach(() => {
        setEnv(naming);
      });

      it("refuses the address when sign-up is open, as it refuses a taken address", async () => {
        const res = await signUp(address);
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
        const res = await signUp(address);
        const body = await res.clone().text();
        await expectRefusedWithNothingCreated(res, CLOSED);
        expect(await (await signUp("stranger@acme.com")).text()).toBe(body);
      });

      it("refuses the address as a disallowed domain when the allowlist excludes it", async () => {
        setEnv({ AUTH_ALLOWED_SIGNUP_DOMAINS: "elsewhere.test" });
        await expectRefusedWithNothingCreated(await signUp(address), {
          status: 403,
          code: "signup_domain_not_allowed",
        });
      });

      it("refuses the address whatever its casing", async () => {
        await expectRefusedWithNothingCreated(await signUp(cased), TAKEN);
      });

      it("refuses the address when it holds a pending invitation", async () => {
        // An invitation is matched on the address alone: it lets a sign-up
        // through the closed gate, it does not show who is signing up.
        setEnv(UNNAMED);
        const inviter = await createTestContext({ orgSlug: "inviter" });
        await seedInvitation({ orgId: inviter.orgId, email: address, invitedBy: inviter.user.id });
        setEnv({ ...naming, AUTH_DISABLE_SIGNUP: "true" });

        const res = await signUp(address);
        expect(res.status).toBe(403);
        expect(await db.select().from(user).where(eq(user.email, address))).toHaveLength(0);
        expect(await db.select().from(organizations)).toHaveLength(1);
      });

      it("refuses the address in an end-user realm too", async () => {
        setRealmResolver(async () => "end_user:spc_test_space_id");
        await expectRefusedWithNothingCreated(await signUp(address), TAKEN);
      });

      it("refuses a wrong bootstrap token", async () => {
        setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });
        const res = await redeem(address, "x".repeat(VALID_TOKEN.length));
        expect(res.status).toBe(401);
        expect(await db.select().from(user)).toHaveLength(0);
        expect(await db.select().from(organizations)).toHaveLength(0);
      });

      it("refuses the address on the sign-up form even while a token is redeemable", async () => {
        setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_DISABLE_SIGNUP: "true" });
        await expectRefusedWithNothingCreated(await signUp(address), CLOSED);
      });

      it("refuses a row Better Auth is about to create unverified", async () => {
        const ctx = await getAuth().$context;
        await expect(
          ctx.internalAdapter.createUser(
            { email: address, name: "Owner" },
            { method: "email-password" },
          ),
        ).rejects.toMatchObject({ body: { code: TAKEN.code } });
        expect(await db.select().from(user)).toHaveLength(0);
      });

      it("refuses a social sign-in whose provider does not assert the address", async () => {
        const ctx = await getAuth().$context;
        await expect(
          ctx.internalAdapter.createUser(
            { email: address, name: "Owner", emailVerified: false },
            { method: "oauth" },
          ),
        ).rejects.toMatchObject({ body: { code: TAKEN.code } });
        expect(await db.select().from(user)).toHaveLength(0);
      });

      describe("with outbound mail configured", () => {
        enableSmtpForSuite();

        it("creates nothing and mails nothing: a verification mail shows who reads the inbox, not who chose the password", async () => {
          // Better Auth answers a refused sign-up like a successful one once
          // verification is required, so the status carries no signal here.
          const mails = await captureMails(async () => {
            const res = await signUp(address);
            expect(res.status).toBe(200);
            expect(((await res.json()) as { token: unknown }).token).toBeNull();
          });
          expect(mails).toHaveLength(0);
          expect(await db.select().from(user)).toHaveLength(0);
          expect(await db.select().from(organizations)).toHaveLength(0);
        });
      });
    });
  }

  it("refuses the owner's address when it is also a platform admin (the installer's default)", async () => {
    setEnv({ AUTH_DISABLE_SIGNUP: "true", AUTH_PLATFORM_ADMIN_EMAILS: "owner@acme.com" });
    await expectRefusedWithNothingCreated(await signUp("owner@acme.com"), CLOSED);
  });

  describe("a platform admin's address, with proof of ownership", () => {
    beforeEach(() => {
      setEnv({
        ...UNNAMED,
        AUTH_PLATFORM_ADMIN_EMAILS: "ops@acme.com",
        AUTH_DISABLE_SIGNUP: "true",
      });
    });

    it("the bootstrap token claims it when no owner is named", async () => {
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });
      expect((await redeem("ops@acme.com")).status).toBe(200);
      await expectRootOrgOwnedBy("ops@acme.com", "acme-hq");
    });

    it("the bootstrap token claims it when it is also the named owner", async () => {
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_BOOTSTRAP_OWNER_EMAIL: "ops@acme.com" });
      expect((await redeem("ops@acme.com")).status).toBe(200);
      await expectRootOrgOwnedBy("ops@acme.com", "acme-hq");
    });

    it("the token does not claim it outside AUTH_ALLOWED_SIGNUP_DOMAINS", async () => {
      // The allowlist exemption under the token is the named owner's alone.
      setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_ALLOWED_SIGNUP_DOMAINS: "elsewhere.test" });
      await expectRefusedWithNothingCreated(await redeem("ops@acme.com"), {
        status: 403,
        code: "signup_domain_not_allowed",
      });
    });

    describe("with outbound mail configured", () => {
      enableSmtpForSuite();

      it("the token's refusal outside the allowlist is the same, and leaves the token redeemable", async () => {
        // Better Auth answers a refused creation like a created account here.
        setEnv({
          AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN,
          AUTH_ALLOWED_SIGNUP_DOMAINS: "elsewhere.test",
        });
        await expectRefusedWithNothingCreated(await redeem("ops@acme.com"), {
          status: 403,
          code: "signup_domain_not_allowed",
        });
        expect(isBootstrapTokenPending()).toBe(true);
      });

      it("a refusal of the create hook that carries no code is still a 403", async () => {
        setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });
        setBeforeSignupHook(() => {
          throw new APIError("FORBIDDEN", { message: "no" });
        });
        try {
          await expectRefusedWithNothingCreated(await redeem("ops@acme.com"), {
            status: 403,
            code: "bootstrap_signup_rejected",
          });
        } finally {
          setBeforeSignupHook(() => {});
        }
      });

      it("any other refusal of the create hook is answered with its own code", async () => {
        setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });
        setBeforeSignupHook(() => {
          throw new APIError("FORBIDDEN", { message: "module_refused", code: "module_refused" });
        });
        try {
          await expectRefusedWithNothingCreated(await redeem("ops@acme.com"), {
            status: 403,
            code: "module_refused",
          });
        } finally {
          setBeforeSignupHook(() => {});
        }
        expect(isBootstrapTokenPending()).toBe(true);
      });
    });

    it("a provider-asserted social sign-in creates it in closed mode", async () => {
      await (
        await getAuth().$context
      ).internalAdapter.createUser(
        { email: "ops@acme.com", name: "Ops", emailVerified: true },
        { method: "oauth" },
      );
      expect((await db.select().from(user)).map((u) => u.email)).toEqual(["ops@acme.com"]);
      expect(await db.select().from(organizations)).toHaveLength(0);
    });

    describe("a magic link sent to the address", () => {
      enableSmtpForSuite();
      const magicLinks = captureIssuedMagicLinks();

      it("creates it verified in closed mode", async () => {
        const sent = await app.request("/api/auth/sign-in/magic-link", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: "ops@acme.com" }),
        });
        expect(sent.status).toBe(200);
        const token = magicLinks.tokenFor("ops@acme.com");
        const verified = await app.request(
          `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
        );
        expect(verified.status).toBeLessThan(400);

        const [u] = await db.select().from(user);
        expect(u).toMatchObject({ email: "ops@acme.com", emailVerified: true });
      });
    });

    it("an account that already holds it still signs in and creates an organization", async () => {
      // Existing accounts are not re-examined: the privilege is read off the
      // address on every request.
      setEnv(UNNAMED);
      setEnv({ AUTH_DISABLE_SIGNUP: undefined });
      await signedUpSession("ops@acme.com");
      setEnv({
        AUTH_PLATFORM_ADMIN_EMAILS: "ops@acme.com",
        AUTH_DISABLE_SIGNUP: "true",
        AUTH_DISABLE_ORG_CREATION: "true",
      });

      const signIn = await app.request("/api/auth/sign-in/email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "ops@acme.com", password: "TestPassword123!" }),
      });
      expect(signIn.status).toBe(200);
      const cookie = signIn.headers
        .getSetCookie()
        .map((c) => c.split(";")[0])
        .join("; ");

      const created = await app.request("/api/orgs", {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({ name: "Ops Org", slug: "ops-org" }),
      });
      expect(created.status).toBe(201);
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
      const magicLinks = captureIssuedMagicLinks();

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
        const token = magicLinks.tokenFor("owner@acme.com");

        const verified = await app.request(
          `/api/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
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

    describe("a social sign-in whose provider asserts the address", () => {
      // The suite has no OAuth2 server to drive `/callback/:id`, so this is
      // the call that route ends in: Better Auth's creation seam, with the
      // `emailVerified` the provider's claim maps to.
      const createFromProvider = async (emailVerified: boolean) =>
        (await getAuth().$context).internalAdapter.createUser(
          { email: "owner@acme.com", name: "Owner", emailVerified },
          { method: "oauth" },
        );

      it("creates the account and the root organization, and retires the token", async () => {
        setPostBootstrapOrgHook(triggerPostBootstrapOrg);
        setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN, AUTH_DISABLE_SIGNUP: "true" });

        await createFromProvider(true);

        await expectRootOrgOwnedBy("owner@acme.com", "acme-hq");
        expect(isBootstrapTokenPending()).toBe(false);
      });

      it("creates nothing when the provider does not assert it", async () => {
        await expect(createFromProvider(false)).rejects.toMatchObject({
          body: { code: TAKEN.code },
        });
        expect(await db.select().from(user)).toHaveLength(0);
      });

      it("in an end-user realm, creates the account and no platform organization", async () => {
        setPostBootstrapOrgHook(triggerPostBootstrapOrg);
        setRealmResolver(async () => "end_user:spc_test_space_id");
        setEnv({ AUTH_BOOTSTRAP_TOKEN: VALID_TOKEN });

        await createFromProvider(true);

        const [u] = await db.select().from(user).where(eq(user.email, "owner@acme.com")).limit(1);
        expect(u!.realm).toBe("end_user:spc_test_space_id");
        expect(await db.select().from(organizations)).toHaveLength(0);
        // No organization was created, so the token has nothing to be retired by.
        expect(isBootstrapTokenPending()).toBe(true);
      });
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
