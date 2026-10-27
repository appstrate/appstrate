// SPDX-License-Identifier: Apache-2.0

/**
 * Better Auth's social callback, driven end to end against a stubbed GitHub: it signs in, and
 * links its identity to, an account of the transaction's realm only.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "@appstrate/db/client";
import { account, session, user as userTable } from "@appstrate/db/schema";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import { flushRedis } from "../../../../../../test/helpers/redis.ts";
import { createTestContext, type TestContext } from "../../../../../../test/helpers/auth.ts";
import { useAuthEnv } from "../../../../../../test/helpers/auth-env.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

/** GitHub's three answers for `email`, verified. Any other host is a test bug. */
function githubAnswering(email: string): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0]) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://github.com/login/oauth/access_token")) {
      return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "user:email" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({ id: 4242, login: "octo", name: "Octo", email });
    }
    if (url === "https://api.github.com/user/emails") {
      return Response.json([{ email, primary: true, verified: true, visibility: "public" }]);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as unknown as typeof fetch;
}

/** Start a GitHub sign-in on the dashboard and play the provider's redirect back. */
async function signInWithGitHub(
  email: string,
  errorCallbackURL?: string,
  callbackURL = "/",
): Promise<Response> {
  const start = await app.request("/api/auth/sign-in/social", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "github", callbackURL, errorCallbackURL }),
  });
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const state = new URL(url).searchParams.get("state")!;
  const cookie = start.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const realFetch = globalThis.fetch;
  globalThis.fetch = githubAnswering(email);
  try {
    return await app.request(`/api/auth/callback/github?code=abc&state=${state}`, {
      headers: { cookie },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("social callback and realms", () => {
  let ctx: TestContext;
  useAuthEnv({ GITHUB_CLIENT_ID: "test-client", GITHUB_CLIENT_SECRET: "test-secret" });

  beforeEach(async () => {
    await truncateAll();
    await flushRedis();
    ctx = await createTestContext({ orgSlug: "socialorg" });
  });

  const providers = async (userId: string) =>
    (await db.select().from(account).where(eq(account.userId, userId))).map((a) => a.providerId);

  it("signs a platform account in on the dashboard and links the identity", async () => {
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, ctx.user.id));
    const res = await signInWithGitHub(ctx.user.email);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).not.toContain("error=");
    expect((await providers(ctx.user.id)).sort()).toEqual(["credential", "github"]);
  });

  it("neither signs in nor links an account of a space's realm holding the address", async () => {
    await db
      .update(userTable)
      .set({ emailVerified: true, realm: `end_user:${ctx.defaultSpaceId}` })
      .where(eq(userTable.id, ctx.user.id));
    await db.delete(session).where(eq(session.userId, ctx.user.id));

    const res = await signInWithGitHub(ctx.user.email);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=signup_disabled");
    expect(await providers(ctx.user.id)).toEqual(["credential"]);
    expect(await db.select().from(session).where(eq(session.userId, ctx.user.id))).toHaveLength(0);
  });

  it("sends the refusal to the error page the sign-in named", async () => {
    await db
      .update(userTable)
      .set({ emailVerified: true, realm: `end_user:${ctx.defaultSpaceId}` })
      .where(eq(userTable.id, ctx.user.id));
    const res = await signInWithGitHub(ctx.user.email, "/login");
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("signup_disabled");
  });

  // The resolver throws on such a transaction; on a browser redirect that would be a bare 403.
  it("redirects an existing account whose transaction resolves to no audience", async () => {
    await db.update(userTable).set({ emailVerified: true }).where(eq(userTable.id, ctx.user.id));
    await db.delete(session).where(eq(session.userId, ctx.user.id));
    const res = await signInWithGitHub(
      ctx.user.email,
      "/login",
      "/api/auth/oauth2/authorize?state=x",
    );
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.pathname).toBe("/login");
    expect(location.searchParams.get("error")).toBe("signup_disabled");
    expect(await db.select().from(session).where(eq(session.userId, ctx.user.id))).toHaveLength(0);
  });
});
