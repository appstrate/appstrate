// SPDX-License-Identifier: Apache-2.0

/**
 * Integration tests for the OIDC `login_hint` plumbing on the server-rendered
 * login and register pages.
 *
 * This closes the gap the unit tests can't reach: `pages.test.ts` proves the
 * templates honour `lockEmail`, but only this level proves the public route
 * actually READS `login_hint` from the query and pins + locks the email field.
 * The invite flow depends on it end-to-end (SPA → authorize → login_hint →
 * locked email), so a regression that drops the param must fail a test here.
 */

import { describe, it, expect, beforeEach } from "bun:test";
import { getTestApp } from "../../../../../../test/helpers/app.ts";
import { truncateAll } from "../../../../../../test/helpers/db.ts";
import {
  createTestContext,
  authHeaders,
  type TestContext,
} from "../../../../../../test/helpers/auth.ts";
import oidcModule from "../../../index.ts";

const app = getTestApp({ modules: [oidcModule] });

async function registerClient(ctx: TestContext): Promise<{ clientId: string }> {
  const res = await app.request("/api/oauth/clients", {
    method: "POST",
    headers: { ...authHeaders(ctx), "Content-Type": "application/json" },
    body: JSON.stringify({
      level: "application" as const,
      name: "Login-hint Test App",
      redirectUris: ["https://acme.example.com/oauth/callback"],
      referencedApplicationId: ctx.defaultAppId,
      allowSignup: true,
    }),
  });
  return (await res.json()) as { clientId: string };
}

/** The readonly attribute must apply specifically to the email field. */
function emailFieldIsReadonly(html: string): boolean {
  const match = html.match(/<input[^>]*\bname="email"[^>]*>/);
  return !!match && /\breadonly\b/.test(match[0]);
}

describe("OIDC login_hint pins + locks the email field", () => {
  let ctx: TestContext;

  beforeEach(async () => {
    await truncateAll();
    ctx = await createTestContext({ orgSlug: "oidchint" });
  });

  it("GET /login pre-fills and locks the email when login_hint is present", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&login_hint=${encodeURIComponent("Invited@Acme.com")}`;
    const res = await app.request(`/api/oauth/login${qs}`);

    expect(res.status).toBe(200);
    const html = await res.text();
    // Normalized (lowercased) hint is reflected into the value.
    expect(html).toContain('value="invited@acme.com"');
    expect(emailFieldIsReadonly(html)).toBe(true);
  });

  it("GET /login leaves the email editable without login_hint", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(`/api/oauth/login?client_id=${encodeURIComponent(clientId)}`);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(emailFieldIsReadonly(html)).toBe(false);
  });

  it("GET /register pre-fills and locks the email when login_hint is present", async () => {
    const { clientId } = await registerClient(ctx);
    const qs = `?client_id=${encodeURIComponent(clientId)}&login_hint=${encodeURIComponent("newbie@acme.com")}`;
    const res = await app.request(`/api/oauth/register${qs}`);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('value="newbie@acme.com"');
    expect(emailFieldIsReadonly(html)).toBe(true);
  });

  it("GET /register leaves the email editable without login_hint", async () => {
    const { clientId } = await registerClient(ctx);
    const res = await app.request(`/api/oauth/register?client_id=${encodeURIComponent(clientId)}`);

    expect(res.status).toBe(200);
    const html = await res.text();
    expect(emailFieldIsReadonly(html)).toBe(false);
  });
});
