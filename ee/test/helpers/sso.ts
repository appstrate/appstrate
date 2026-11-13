// SPDX-License-Identifier: LicenseRef-Appstrate-Commercial

/**
 * Fixtures for enterprise sign-in tests: an organization's settings seeded
 * straight into this package's tables, and real OAuth callbacks driven
 * through Better Auth with the provider's token endpoint answered in-process
 * (no network, nothing in the auth layer stubbed).
 */

import { afterAll, beforeAll } from "bun:test";
import { getEeDb } from "../../src/db.ts";
import { ssoConnections, ssoDomains, ssoSessions } from "../../drizzle/schema.ts";
import { useAuthEnv } from "../../../apps/api/test/helpers/auth-env.ts";

export const TENANT = "11111111-2222-3333-4444-555555555555";
export const OTHER_TENANT = "99999999-8888-7777-6666-555555555555";
export const DOMAIN = "corp.test";

export async function seedSso(opts: {
  orgId: string;
  tenantId?: string | null;
  domains?: { domain: string; verified?: boolean }[];
  enforced?: boolean;
  joinRole?: "member" | "guest";
}): Promise<{ domainIds: string[] }> {
  const db = getEeDb();
  await db.insert(ssoConnections).values({
    orgId: opts.orgId,
    tenantId: opts.tenantId === undefined ? TENANT : opts.tenantId,
    joinRole: opts.joinRole ?? "member",
    enforcedAt: opts.enforced ? new Date() : null,
  });
  const domainIds: string[] = [];
  for (const { domain, verified = true } of opts.domains ?? [{ domain: DOMAIN }]) {
    const [row] = await db
      .insert(ssoDomains)
      .values({
        orgId: opts.orgId,
        domain,
        verificationToken: `token-${domain}`,
        verifiedAt: verified ? new Date() : null,
      })
      .returning({ id: ssoDomains.id });
    domainIds.push(row!.id);
  }
  return { domainIds };
}

/** Mark `sessionId` as opened by a Microsoft sign-in of `tenantId`, `ageMs` ago. */
export async function seedMicrosoftSession(
  sessionId: string,
  userId: string,
  tenantId = TENANT,
  ageMs = 0,
): Promise<void> {
  await getEeDb()
    .insert(ssoSessions)
    .values({ sessionId, userId, tenantId, createdAt: new Date(Date.now() - ageMs) });
}

/** Register the instance's Microsoft (and GitHub) providers for the suite. */
export function withSocialProviders(): void {
  useAuthEnv({
    MICROSOFT_CLIENT_ID: "ms-client-id",
    MICROSOFT_CLIENT_SECRET: "ms-client-secret",
    GITHUB_CLIENT_ID: "gh-client-id",
    GITHUB_CLIENT_SECRET: "gh-client-secret",
  });
}

type Handler = (req: Request) => Response | Promise<Response> | null;
let handlers: Handler[] = [];

/** For the suite, answer the providers' endpoints from `handlers`; everything else goes through. */
export function interceptProviderFetches(): void {
  const original = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      for (const handler of handlers) {
        const res = await handler(req);
        if (res) return res;
      }
      return original(input, init);
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = original;
    handlers = [];
  });
}

function unsignedJwt(claims: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "none", typ: "JWT" })}.${enc(claims)}.sig`;
}

export interface MicrosoftIdentity {
  email: string;
  tenantId: string;
  oid?: string;
  name?: string;
  xmsEdov?: boolean;
}

interface TestApp {
  request(path: string, init?: RequestInit): Response | Promise<Response>;
}

function cookiesOf(res: Response): string {
  return res.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
}

/** Drive `/sign-in/social` then `/callback/:provider`; resolves the callback's response. */
async function socialSignIn(
  app: TestApp,
  provider: "microsoft" | "github",
  answer: Handler,
): Promise<Response> {
  const start = await app.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, callbackURL: "/", errorCallbackURL: "/login" }),
  });
  if (!start.ok) throw new Error(`sign-in/social answered ${start.status}: ${await start.text()}`);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  handlers = [answer];
  try {
    return await app.request(`/api/auth/callback/${provider}?code=test-code&state=${state}`, {
      headers: { Cookie: cookiesOf(start) },
    });
  } finally {
    handlers = [];
  }
}

/** A Microsoft sign-in of `identity`, as Entra would answer it. */
export function microsoftSignIn(app: TestApp, identity: MicrosoftIdentity): Promise<Response> {
  const idToken = unsignedJwt({
    oid: identity.oid ?? `oid-${identity.email}`,
    tid: identity.tenantId,
    email: identity.email,
    name: identity.name ?? identity.email,
    xms_edov: identity.xmsEdov ?? true,
  });
  return socialSignIn(app, "microsoft", (req) =>
    new URL(req.url).hostname === "login.microsoftonline.com"
      ? Response.json({
          access_token: "ms-access",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 3600,
        })
      : null,
  );
}

/** A GitHub sign-in of `email` (verified, primary). */
export function githubSignIn(app: TestApp, email: string): Promise<Response> {
  return socialSignIn(app, "github", (req) => {
    const url = new URL(req.url);
    if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
      return Response.json({
        access_token: "gh-access",
        token_type: "bearer",
        scope: "user:email",
      });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user") {
      return Response.json({ id: 4242, login: "gh-user", name: "GH User", email, avatar_url: "" });
    }
    if (url.hostname === "api.github.com" && url.pathname === "/user/emails") {
      return Response.json([{ email, primary: true, verified: true, visibility: "public" }]);
    }
    return null;
  });
}

/** The session cookie a callback set, or `null` when it opened none. */
export function sessionCookieFrom(res: Response): string | null {
  const match = /better-auth\.session_token=([^;]+)/.exec(res.headers.get("set-cookie") ?? "");
  return match?.[1] ? `better-auth.session_token=${match[1]}` : null;
}

/** The `error` code of a callback's redirect, or `null`. */
export function redirectError(res: Response): string | null {
  const location = res.headers.get("location");
  return location ? new URL(location, "http://localhost").searchParams.get("error") : null;
}
