// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E for the organization invitation flow.
 *
 * The accept step (and the email-mismatch guard) are mode-independent: they
 * only require an authenticated session, so we inject the invitee's cookie and
 * drive the page directly — no login UI involved. The inline signup-via-invite
 * form only exists in OSS mode (an OIDC instance redirects unauthenticated
 * visitors to its own IdP), so that test self-skips when an OIDC instance
 * client is configured.
 *
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { registerUser } from "../../helpers/seed.ts";
import type { Browser } from "@playwright/test";

function uid() {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** A browser context carrying only the given Better Auth session cookie. */
async function contextWithCookie(browser: Browser, cookie: string) {
  const context = await browser.newContext();
  const match = cookie.match(/better-auth\.session_token=([^;]+)/);
  if (match) {
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: match[1],
        domain: "localhost",
        path: "/",
      },
    ]);
  }
  return context;
}

test.describe("Organization invitation flow", () => {
  test("an authenticated invitee joins via the explicit accept button @critical", async ({
    request,
    browser,
    browserCtx,
    orgOnlyClient,
  }) => {
    const invitedEmail = `e2e-invitee-${uid()}@test.com`;
    // The invitee already has an account (the mode-independent path).
    const invitee = await registerUser(request, { email: invitedEmail });

    const inviteRes = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
      email: invitedEmail,
      role: "member",
    });
    expect(inviteRes.status()).toBe(201);
    const { token } = (await inviteRes.json()) as { token: string };

    const ctx = await contextWithCookie(browser, invitee.cookie);
    const page = await ctx.newPage();
    await page.goto(`/invite/${token}`);

    // Authenticated + email matches → the explicit "Rejoindre {org}" button.
    const joinButton = page.getByRole("button", { name: /Rejoindre/i });
    await expect(joinButton).toBeVisible({ timeout: 10_000 });
    await joinButton.click();

    // Accept resolved → the page navigates off /invite.
    await page.waitForURL((url) => !url.pathname.startsWith("/invite"), { timeout: 10_000 });

    // Acceptance persisted: re-opening the link now reports it consumed.
    await page.goto(`/invite/${token}`);
    await expect(page.getByText(/déjà été acceptée/i)).toBeVisible({ timeout: 10_000 });

    await ctx.close();
  });

  test("the page blocks a logged-in account whose email does not match", async ({
    request,
    browser,
    browserCtx,
    orgOnlyClient,
  }) => {
    // Logged in as one account, but the invitation targets a different email.
    const wrongUser = await registerUser(request);
    const inviteRes = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
      email: `e2e-target-${uid()}@test.com`,
      role: "member",
    });
    expect(inviteRes.status()).toBe(201);
    const { token } = (await inviteRes.json()) as { token: string };

    const ctx = await contextWithCookie(browser, wrongUser.cookie);
    const page = await ctx.newPage();
    await page.goto(`/invite/${token}`);

    await expect(page.getByText(/cette invitation est destinée à/i)).toBeVisible({
      timeout: 10_000,
    });
    await expect(page.getByRole("button", { name: /Se déconnecter et réessayer/i })).toBeVisible();
    // No join button is offered on a mismatch.
    await expect(page.getByRole("button", { name: /Rejoindre/i })).toHaveCount(0);

    await ctx.close();
  });

  test("a new invitee signs up inline and joins (OSS mode)", async ({
    browser,
    browserCtx,
    orgOnlyClient,
  }) => {
    const invitedEmail = `e2e-newinvitee-${uid()}@test.com`;
    const inviteRes = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
      email: invitedEmail,
      role: "member",
    });
    expect(inviteRes.status()).toBe(201);
    const { token } = (await inviteRes.json()) as { token: string };

    const ctx = await browser.newContext(); // anonymous
    const page = await ctx.newPage();
    await page.goto(`/invite/${token}`);

    // The inline form only exists in OSS mode; an OIDC instance redirects
    // unauthenticated visitors to its own server-rendered pages instead.
    const oidc = await page.evaluate(
      () => !!(window as unknown as { __APP_CONFIG__?: { oidc?: unknown } }).__APP_CONFIG__?.oidc,
    );
    test.skip(oidc, "OIDC instance — inline signup form is not rendered on the invite page");

    // The register form is shown with the invited email pinned (read-only).
    const emailField = page.locator("#email");
    await expect(emailField).toHaveValue(invitedEmail);
    await expect(emailField).toHaveJSProperty("readOnly", true);

    await page.locator("#displayName").fill("E2E Invitee");
    await page.locator("#password").fill("TestPassword123!");
    await page.getByRole("button", { name: /Créer un compte/i }).click();

    // The invited email is auto-verified (a pending invitation proves
    // ownership), so signup establishes a session and the page re-renders
    // into the authenticated branch with the explicit join button.
    const joinButton = page.getByRole("button", { name: /Rejoindre/i });
    await expect(joinButton).toBeVisible({ timeout: 15_000 });
    await joinButton.click();

    await page.waitForURL((url) => !url.pathname.startsWith("/invite"), { timeout: 10_000 });

    await page.goto(`/invite/${token}`);
    await expect(page.getByText(/déjà été acceptée/i)).toBeVisible({ timeout: 10_000 });

    await ctx.close();
  });
});
