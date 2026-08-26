// SPDX-License-Identifier: Apache-2.0

/**
 * Test authentication helpers.
 *
 * `createTestUser` seeds the Better Auth tables (user/account/session/profiles)
 * directly and crafts the signed session cookie itself — skipping the full
 * HTTP sign-up round-trip that used to dominate integration-test setup time.
 * The cookie is still a REAL Better Auth cookie: the auth middleware verifies
 * it through `getAuth().api.getSession()` (HMAC signature + DB session row),
 * so nothing about what the tests prove is weakened.
 *
 * Tests that exercise the sign-up HTTP flow itself (email-verification
 * interstitial, signup gates, …) POST `/api/auth/sign-up/email` directly
 * via `app.request()`.
 *
 * Organizations, memberships, and spaces are seeded directly in the DB.
 */
import { eq, sql } from "drizzle-orm";
import { getAuth } from "@appstrate/db/auth";
import { db } from "./db.ts";
import { prefixedId, SPACE_ID_RE } from "../../src/lib/ids.ts";
import {
  organizations,
  organizationMembers,
  spaces,
  user as userTable,
  session as sessionTable,
  account as accountTable,
  profiles,
} from "@appstrate/db/schema";
import type { OrgRole } from "@appstrate/shared-types";

let counter = 0;
function nextId() {
  return `test-${++counter}-${Date.now()}`;
}

export interface TestUser {
  id: string;
  email: string;
  name: string;
}

export interface TestOrg {
  id: string;
  name: string;
  slug: string;
}

export interface TestContext {
  user: TestUser;
  org: TestOrg;
  cookie: string;
  orgId: string;
  defaultSpaceId: string;
}

// ─── Session-cookie crafting (fast path) ─────────────────────────────────────
//
// Better Auth signs the session cookie via better-call's `signCookieValue`:
//   encodeURIComponent(`${token}.${base64(HMAC-SHA256(secret, token))}`)
// (see better-call/dist/crypto.mjs — standard base64 via btoa, NOT base64url).
// The secret is read from the LIVE auth instance (`getAuth().$context.secret`)
// — not from `getEnv()` — so the crafted signature always matches what the
// middleware verifies with, even when a unit test mutates `BETTER_AUTH_SECRET`
// in `process.env` or `_rebuildAuthForTesting()` swaps the instance mid-suite.
// If a better-auth/better-call upgrade ever changes this format, every
// integration test fails with 401 on its first authenticated request — loud
// and immediate.

const SESSION_COOKIE_NAME = "better-auth.session_token";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // matches auth.ts session.expiresIn

const textEncoder = new TextEncoder();
let signingKey: CryptoKey | null = null;
let signingKeySecret: string | null = null;

async function getSigningKey(): Promise<CryptoKey> {
  const secret = (await getAuth().$context).secret;
  if (!signingKey || signingKeySecret !== secret) {
    signingKey = await crypto.subtle.importKey(
      "raw",
      textEncoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    signingKeySecret = secret;
  }
  return signingKey;
}

/** Build the `Cookie` header value for a session token, signed like Better Auth does. */
async function signSessionCookie(token: string): Promise<string> {
  const key = await getSigningKey();
  const sigBuf = await crypto.subtle.sign("HMAC", key, textEncoder.encode(token));
  const signature = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(`${token}.${signature}`)}`;
}

function randomSessionToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create a test user by seeding the Better Auth tables directly.
 * Returns the user record and a signed session cookie that the app's
 * auth middleware accepts (verified through `getSession()` like any
 * production cookie — signature check + session row lookup).
 *
 * Rows seeded (mirrors what a real sign-up produces in SMTP-off mode):
 *   - `user`     — emailVerified=false (pass `emailVerified: true` to mirror a
 *                  social-login outcome, where BA's OAuth callback marks the
 *                  brand-new row verified), realm="platform"
 *   - `profiles` — inserted by the BA `user.create.after` hook in prod
 *   - `account`  — providerId="credential" with the AUTH_FAST_TEST_HASH
 *                  SHA-256 password hash, so HTTP sign-in with the same
 *                  password still verifies (see packages/db/src/auth.ts)
 *   - `session`  — realm="platform" (denormalized, read by the realm guard)
 *
 * Tests that must exercise the real sign-up HTTP flow POST
 * `/api/auth/sign-up/email` directly.
 */
export async function createTestUser(
  overrides: Partial<{
    email: string;
    name: string;
    password: string;
    emailVerified: boolean;
  }> = {},
): Promise<TestUser & { cookie: string }> {
  const email = (overrides.email ?? `test-${nextId()}@test.com`).toLowerCase();
  const name = overrides.name ?? `Test User ${nextId()}`;
  const password = overrides.password ?? "TestPassword123!";
  const emailVerified = overrides.emailVerified ?? false;

  const userId = crypto.randomUUID();
  const token = randomSessionToken();
  // AUTH_FAST_TEST_HASH=1 (set by test/setup/preload.ts) swaps Better Auth's
  // scrypt for plain SHA-256 — mirror that scheme so a later HTTP sign-in
  // with this password verifies against the account row.
  const passwordHash = new Bun.CryptoHasher("sha256").update(password).digest("hex");

  await db.insert(userTable).values({ id: userId, name, email, emailVerified, realm: "platform" });
  await Promise.all([
    db.insert(profiles).values({ id: userId, displayName: name || email, language: "fr" }),
    db.insert(accountTable).values({
      id: crypto.randomUUID(),
      accountId: userId,
      providerId: "credential",
      userId,
      password: passwordHash,
    }),
    db.insert(sessionTable).values({
      id: crypto.randomUUID(),
      token,
      userId,
      expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      realm: "platform",
    }),
  ]);

  return { id: userId, email, name, cookie: await signSessionCookie(token) };
}

/**
 * Create a test organization and add the given user as owner.
 * Also creates a default space (required by many flows).
 */
export async function createTestOrg(
  userId: string,
  overrides: Partial<{ name: string; slug: string }> = {},
): Promise<{ org: TestOrg; defaultSpaceId: string }> {
  const slug = overrides.slug ?? `test-org-${nextId()}`;
  const name = overrides.name ?? `Test Org ${slug}`;

  const [org] = await db
    .insert(organizations)
    .values({ name, slug, createdBy: userId })
    .returning();

  // Add user as owner
  await db.insert(organizationMembers).values({
    orgId: org!.id,
    userId,
    role: "owner",
  });

  // Create the default space. The id MUST be minted the way production mints
  // it (`prefixedId("spc")`): `assertSpaceId` in `src/lib/ids.ts` rejects any
  // other shape, and this fixture previously minted `app_` + a 16-char dashless
  // uuid slice — a shape the real guard refuses on both counts. Asserted here
  // rather than left to the first 400 in an unrelated test.
  const spaceId = prefixedId("spc");
  if (!SPACE_ID_RE.test(spaceId)) {
    throw new Error(`test fixture minted a space id the platform rejects: ${spaceId}`);
  }
  await db.insert(spaces).values({
    id: spaceId,
    orgId: org!.id,
    name: "Default",
    isDefault: true,
    createdBy: userId,
  });

  return {
    org: { id: org!.id, name: org!.name, slug: org!.slug },
    defaultSpaceId: spaceId,
  };
}

/**
 * Add a user as a member of an existing organization.
 */
export async function addOrgMember(
  orgId: string,
  userId: string,
  role: OrgRole = "member",
): Promise<void> {
  await db.insert(organizationMembers).values({ orgId, userId, role });
}

/**
 * Build authentication headers for test requests.
 * Includes session cookie, org ID, and space ID from a TestContext.
 * For org-only routes that don't need X-Space-Id, use orgOnlyHeaders() instead.
 */
export function authHeaders(
  ctx: TestContext,
  extra?: Record<string, string>,
): Record<string, string> {
  return {
    Cookie: ctx.cookie,
    "X-Org-Id": ctx.orgId,
    "X-Space-Id": ctx.defaultSpaceId,
    ...extra,
  };
}

/**
 * Build authentication headers WITHOUT X-Space-Id — for org-scoped routes only.
 */
export function orgOnlyHeaders(
  ctx: TestContext,
  extra?: Record<string, string>,
): Record<string, string> {
  return { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId, ...extra };
}

/**
 * Opt the org into dashboard-level OAuth SSO. Required for tests that
 * create/use `level: "org"` OAuth clients — without this, the admin routes
 * and token-mint path reject with 403 by design.
 */
export async function enableDashboardSso(orgId: string): Promise<void> {
  await db
    .update(organizations)
    .set({
      orgSettings: sql`COALESCE(${organizations.orgSettings}, '{}'::jsonb) || '{"dashboard_sso_enabled":true}'::jsonb`,
    })
    .where(eq(organizations.id, orgId));
}

/**
 * Full setup: create a user + org + session in one call.
 * Returns everything needed to make authenticated API requests.
 */
export async function createTestContext(
  overrides: Partial<{ email: string; name: string; orgName: string; orgSlug: string }> = {},
): Promise<TestContext> {
  const testUser = await createTestUser({
    email: overrides.email,
    name: overrides.name,
  });
  const { org, defaultSpaceId } = await createTestOrg(testUser.id, {
    name: overrides.orgName,
    slug: overrides.orgSlug,
  });

  return {
    user: { id: testUser.id, email: testUser.email, name: testUser.name },
    org,
    cookie: testUser.cookie,
    orgId: org.id,
    defaultSpaceId,
  };
}
