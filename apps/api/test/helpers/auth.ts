// SPDX-License-Identifier: Apache-2.0

/**
 * Test authentication helpers.
 *
 * Uses Better Auth's actual sign-up API to create real users with valid signed session cookies.
 * Organizations, memberships, and applications are seeded directly in the DB.
 */
import { db } from "./db.ts";
import { organizations, organizationMembers, applications } from "@appstrate/db/schema";
import type { OrgRole } from "@appstrate/shared-types";
import { getTestApp } from "./app.ts";

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
  defaultAppId: string;
}

/**
 * Create a test user via Better Auth's sign-up endpoint.
 * Returns the user record and the signed session cookie.
 *
 * This goes through the real auth flow: sign-up → session creation → cookie.
 */
export async function createTestUser(
  overrides: Partial<{ email: string; name: string; password: string }> = {},
): Promise<TestUser & { cookie: string }> {
  const app = getTestApp();
  const email = overrides.email ?? `test-${nextId()}@test.com`;
  const name = overrides.name ?? `Test User ${nextId()}`;
  const password = overrides.password ?? "TestPassword123!";

  const res = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });

  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`Sign-up failed (${res.status}): ${body}`);
  }

  // Extract session cookie from Set-Cookie header
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) {
    throw new Error(`No session cookie in sign-up response: ${setCookie}`);
  }
  const cookie = `better-auth.session_token=${match[1]}`;

  const body = (await res.json()) as { user: { id: string; email: string; name: string } };
  if (!body.user?.id) {
    throw new Error(`Sign-up response missing user data: ${JSON.stringify(body)}`);
  }
  return {
    id: body.user.id,
    email: body.user.email,
    name: body.user.name,
    cookie,
  };
}

/**
 * Create a session for an existing user via sign-in.
 * Returns the signed session cookie.
 */
export async function createTestSession(
  email: string,
  password: string = "TestPassword123!",
): Promise<string> {
  const app = getTestApp();

  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });

  if (res.status !== 200) {
    const body = await res.text();
    throw new Error(`Sign-in failed (${res.status}): ${body}`);
  }

  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/better-auth\.session_token=([^;]+)/);
  if (!match) {
    throw new Error(`No session cookie in sign-in response: ${setCookie}`);
  }
  return `better-auth.session_token=${match[1]}`;
}

/**
 * Create a test organization and add the given user as owner.
 * Also creates a default application (required by many flows).
 */
export async function createTestOrg(
  userId: string,
  overrides: Partial<{ name: string; slug: string }> = {},
): Promise<{ org: TestOrg; defaultAppId: string }> {
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

  // Create default application
  const appId = `app_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await db.insert(applications).values({
    id: appId,
    orgId: org!.id,
    name: "Default",
    isDefault: true,
    createdBy: userId,
  });

  return {
    org: { id: org!.id, name: org!.name, slug: org!.slug },
    defaultAppId: appId,
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
 * Includes session cookie, org ID, and app ID from a TestContext.
 * For org-only routes that don't need X-App-Id, use orgOnlyHeaders() instead.
 */
export function authHeaders(
  ctx: TestContext,
  extra?: Record<string, string>,
): Record<string, string> {
  return { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId, "X-App-Id": ctx.defaultAppId, ...extra };
}

/**
 * Build authentication headers WITHOUT X-App-Id — for org-scoped routes only.
 */
export function orgOnlyHeaders(
  ctx: TestContext,
  extra?: Record<string, string>,
): Record<string, string> {
  return { Cookie: ctx.cookie, "X-Org-Id": ctx.orgId, ...extra };
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
  const { org, defaultAppId } = await createTestOrg(testUser.id, {
    name: overrides.orgName,
    slug: overrides.orgSlug,
  });

  return {
    user: { id: testUser.id, email: testUser.email, name: testUser.name },
    org,
    cookie: testUser.cookie,
    orgId: org.id,
    defaultAppId,
  };
}
