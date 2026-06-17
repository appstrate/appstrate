// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E for the single auth seam (`HostedAuthGate` / `useHostedAuthRedirect`).
 *
 * The whole point of the refactor is that EVERY auth-entry route funnels
 * through one OIDC redirect mechanism — no page can render a native Better Auth
 * form when the instance runs the OIDC IdP. These tests assert that invariant
 * against whichever mode the server booted in (the suite is run twice — OIDC
 * and OSS — in CI):
 *
 *   - OIDC instance → the route leaves the SPA and lands on a server-rendered
 *     `/api/*` hosted page (login / register / authorize).
 *   - OSS instance  → the route stays on the SPA and renders its native form.
 *
 * Mode is read from the injected `window.__APP_CONFIG__` in the served
 * index.html (via a plain GET, before any SPA redirect can fire) so detection
 * never races the redirect it is testing.
 *
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import type { APIRequestContext, Page } from "@playwright/test";

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * The auth-entry routes wrapped by `HostedAuthGate` in app.tsx. `reset-password`
 * carries a token so its OSS form renders (a tokenless visit shows the
 * "request a new link" message instead, which has no form).
 */
const GATED_ROUTES = [
  "/login",
  "/register",
  "/forgot-password",
  "/reset-password?token=probe-token",
  "/magic-link",
];

/**
 * Read the boot mode from the served HTML, not the live SPA: a GET of `/`
 * returns index.html with the injected `window.__APP_CONFIG__`, which only
 * carries an `oidc` object when the OIDC module is loaded. This sidesteps the
 * race where reading the flag from a live page happens after the gate already
 * navigated away.
 */
async function serverIsOidc(request: APIRequestContext): Promise<boolean> {
  const html = await (await request.get("/")).text();
  return /"oidc"\s*:\s*\{/.test(html);
}

/** Assert the browser left the SPA for a server-rendered hosted auth page. */
async function expectRedirectedToHostedPage(page: Page) {
  await page.waitForURL((url) => url.pathname.startsWith("/api/"), { timeout: 15_000 });
  expect(new URL(page.url()).pathname.startsWith("/api/")).toBe(true);
}

test.describe("Hosted auth gate — single entry point", () => {
  test("every auth-entry route funnels through one OIDC redirect (or renders natively in OSS) @critical", async ({
    browser,
    request,
  }) => {
    const oidc = await serverIsOidc(request);
    const ctx = await browser.newContext(); // anonymous — no session cookie
    const page = await ctx.newPage();

    for (const route of GATED_ROUTES) {
      await page.goto(route);

      if (oidc) {
        await expectRedirectedToHostedPage(page);
      } else {
        // OSS: the gate is a pass-through — the SPA route renders its form.
        const path = route.split("?")[0];
        await expect(page).toHaveURL(new RegExp(`${path}(?:\\?|$)`));
        await expect(page.locator("form input").first()).toBeVisible({ timeout: 10_000 });
      }
    }

    await ctx.close();
  });

  test("an unauthenticated invite uses the same hosted gate (OIDC mode)", async ({
    browser,
    request,
    browserCtx,
    orgOnlyClient,
  }) => {
    const oidc = await serverIsOidc(request);
    test.skip(
      !oidc,
      "OSS instance — the invite renders the inline form (covered by invite-flow spec)",
    );

    const invitedEmail = `e2e-gate-${uid()}@test.com`;
    const inviteRes = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
      email: invitedEmail,
      role: "member",
    });
    expect(inviteRes.status()).toBe(201);
    const { token } = (await inviteRes.json()) as { token: string };

    const ctx = await browser.newContext(); // anonymous
    const page = await ctx.newPage();
    await page.goto(`/invite/${token}`);

    // The invite drives `useHostedAuthRedirect` directly (dynamic starter +
    // login-hint), so it must leave the SPA for the hosted page just like the
    // wrapped routes — proving both paths share one mechanism.
    await expectRedirectedToHostedPage(page);

    await ctx.close();
  });
});
