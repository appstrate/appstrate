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
  const sessionToken = cookie.match(/better-auth\.session_token=([^;]+)/)?.[1];
  if (sessionToken) {
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: sessionToken,
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

  test("logging out from a wrong-account invite preserves the return path (OIDC)", async ({
    request,
    browser,
    browserCtx,
    orgOnlyClient,
  }) => {
    // OIDC-only: the OSS logout keeps the /invite page mounted (it re-renders
    // into its own login form), so there is no post-logout redirect to
    // preserve. In OIDC mode logout leaves the SPA for the IdP and only lands
    // back on /login, so the return path must be stashed for the callback.
    const html = await (await request.get("/")).text();
    test.skip(!/"oidc"\s*:\s*\{/.test(html), "OSS instance — logout keeps /invite mounted");

    const wrongUser = await registerUser(request);
    const inviteRes = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
      email: `e2e-target-${uid()}@test.com`,
      role: "member",
    });
    expect(inviteRes.status()).toBe(201);
    const { token } = (await inviteRes.json()) as { token: string };

    const ctx = await contextWithCookie(browser, wrongUser.cookie);
    const page = await ctx.newPage();
    // `startOidcLogout` stashes the redirect synchronously, then navigates to
    // the same-origin /api/oauth/logout. Aborting that top-level navigation
    // leaves the renderer on a chrome-error document where sessionStorage reads
    // throw a SecurityError (flaky). Instead, fulfill it with a blank same-origin
    // page: the navigation settles deterministically and sessionStorage (scoped
    // to the origin) survives, so the stashed redirect stays readable.
    await page.route("**/api/oauth/logout*", (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>logout</title>",
      }),
    );
    await page.goto(`/invite/${token}`);

    await page.getByRole("button", { name: /Se déconnecter et réessayer/i }).click();
    // Let the fulfilled same-origin logout navigation finish before reading storage.
    await page.waitForURL(/\/api\/oauth\/logout/);

    // The invite path is stashed in the same key handleOidcCallback consumes,
    // so after re-login the user returns to the invitation (not onboarding).
    await expect
      .poll(() => page.evaluate(() => sessionStorage.getItem("appstrate_oidc_redirect")))
      .toBe(`/invite/${token}`);

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

test("onboarding offers organization roles and submits a standard invitation", async ({
  authedPage: page,
  browserCtx,
}) => {
  await page.goto("/onboarding/members");
  const email = `onboarding-member-${uid()}@test.com`;
  await page.getByRole("textbox", { name: /Adresse e-mail|Email address/ }).fill(email);
  await expect(page.getByRole("radio", { name: /Invité|Guest/ })).toHaveCount(0);
  await page.getByRole("radio", { name: /Utilisateur standard|Standard user/ }).check();
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${browserCtx.org.orgId}/members`),
  );
  await page.getByRole("textbox", { name: /Adresse e-mail|Email address/ }).press("Enter");
  const response = await submitted;
  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({ email, role: "member", space_assignments: [] });
  await expect(page.getByText(email, { exact: true })).toBeVisible();
});

test("mobile organization invitations keep email usable and submit with Enter", async ({
  authedPage: page,
  browserCtx,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/org-settings/members");
  await page.getByTestId("invite-org-user-button").click();
  const dialog = page.getByRole("dialog");
  const email = dialog.getByRole("textbox", {
    name: /Adresse e-mail|Email address/,
  });
  await expect(email).toBeVisible();
  await expect(dialog.getByRole("radio", { name: /Invité|Guest/ })).toBeVisible();
  expect((await email.boundingBox())!.width).toBeGreaterThan(250);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const address = `mobile-invite-${uid()}@test.com`;
  await email.fill(address);
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${browserCtx.org.orgId}/members`),
  );
  await email.press("Enter");
  expect((await submitted).status()).toBe(201);
  await expect(page.getByText(address, { exact: true })).toBeVisible();
  await expect(dialog).toHaveCount(0);
  await page.getByTestId("invite-org-user-button").click();
  await expect(email).toHaveValue("");
});

test("invitation space catalogue failures are visible and recover through retry", async ({
  authedPage: page,
}) => {
  await page.route("**/api/roles", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/problem+json",
      body: JSON.stringify({
        title: "Role catalog unavailable",
        detail: "Role catalog unavailable",
        status: 503,
      }),
    }),
  );
  await page.goto("/org-settings/members");
  await page.getByTestId("invite-org-user-button").click();
  const alert = page.getByRole("alert").filter({ hasText: "Role catalog unavailable" });
  await expect(alert).toBeVisible();
  await expect(
    page.getByRole("combobox", {
      name: /Sélectionner un espace|Select a space/i,
    }),
  ).toHaveCount(0);
  await page.unroute("**/api/roles");
  await alert.getByRole("button", { name: /Réessayer|Retry/i }).click();
  const add = page.getByRole("combobox", {
    name: /Sélectionner un espace|Select a space/i,
  });
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByRole("option", { name: "Default", exact: true })).toBeVisible();
});

test("a pending standard invitation can become a guest invitation with a space assignment", async ({
  authedPage: page,
  browserCtx,
  orgOnlyClient,
}) => {
  const email = `edit-invite-${uid()}@test.com`;
  const created = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
    email,
    role: "member",
  });
  expect(created.status()).toBe(201);
  const invitation = await created.json();
  await page.goto("/org-settings/members");
  await page.getByRole("button", { name: /^(Modifier|Edit)$/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("radio", { name: /Invité|Guest/ }).check();
  await dialog.getByRole("button", { name: /Enregistrer|Save/ }).click();
  await expect(
    dialog.getByRole("alert").filter({ hasText: /au moins un espace|at least one space/i }),
  ).toBeVisible();
  await dialog
    .getByRole("combobox", {
      name: /Sélectionner un espace|Select a space/i,
    })
    .click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /au moins un espace|at least one space/i }),
  ).toHaveCount(0);
  const updated = page.waitForResponse(
    (response) =>
      response.request().method() === "PUT" &&
      response.url().endsWith(`/api/orgs/${browserCtx.org.orgId}/invitations/${invitation.id}`),
  );
  await dialog.getByRole("button", { name: /Enregistrer|Save/ }).click();
  const response = await updated;
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({
    role: "guest",
    space_assignments: [{ space_id: browserCtx.org.defaultSpaceId, preset_role: "operator" }],
  });
  await expect(dialog).toHaveCount(0);
  const persisted = await orgOnlyClient.get(`/orgs/${browserCtx.org.orgId}`);
  expect(
    (await persisted.json()).invitations.find((item: { id: string }) => item.id === invitation.id),
  ).toMatchObject({
    email,
    role: "guest",
    space_assignments: [{ space_id: browserCtx.org.defaultSpaceId, preset_role: "operator" }],
  });
});

test("admin invitations explain all-space access while preserving an optional assignment draft", async ({
  authedPage: page,
  browserCtx,
}) => {
  await page.goto("/org-settings/members");
  await page.getByTestId("invite-org-user-button").click();
  const dialog = page.getByRole("dialog");
  const pickRole = (name: RegExp) => dialog.getByRole("radio", { name }).check();
  await dialog
    .getByRole("textbox", { name: /Adresse e-mail|Email address/ })
    .fill(`admin-invite-${uid()}@test.com`);
  await dialog.getByRole("combobox", { name: /Sélectionner un espace|Select a space/ }).click();
  await page.getByRole("option", { name: "Default", exact: true }).click();
  const assignmentRole = dialog.getByRole("combobox", { name: /Default/ });
  await assignmentRole.click();
  await page.getByRole("option", { name: /^(Lecteur|Viewer)$/ }).click();
  await pickRole(/^(Administrateur|Admin)\b/);
  await expect(dialog.getByRole("group", { name: /^Espaces$|^Spaces$/ })).toBeVisible();
  const allSpaces = dialog.getByRole("textbox", { name: /^Espaces$|^Spaces$/ });
  await expect(allSpaces).toBeDisabled();
  await expect(allSpaces).toHaveValue(/Tous les espaces.*tous les droits|All spaces.*full access/i);
  await expect(
    dialog.getByText(/Administre l’organisation|Manages the organization/i).last(),
  ).toBeVisible();
  await pickRole(/Utilisateur standard|Standard user/);
  await expect(assignmentRole).toBeEnabled();
  await expect(assignmentRole).toContainText(/Lecteur|Viewer/);
  await pickRole(/^(Administrateur|Admin)\b/);
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${browserCtx.org.orgId}/members`),
  );
  await dialog.getByRole("textbox", { name: /Adresse e-mail|Email address/ }).press("Enter");
  const response = await submitted;
  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({ role: "admin", space_assignments: [] });
});
