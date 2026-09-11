// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E for the onboarding escape hatches.
 *
 * A signed-in user with no organization is pinned to `/onboarding/*` by
 * `OrgGate`. Before the account menu was mounted in `OnboardingLayout` there
 * was no way out of that state — a user who signed in with the wrong account
 * had to clear cookies by hand. These tests assert the two exits:
 *
 *   - sign out from any onboarding step → back to `/login`;
 *   - once an org exists, "Retour à l'application" → back to the dashboard.
 *
 * They also pin the reason the onboarding menu is `minimal`: `/preferences`
 * lives behind `OrgGate`, so offering it here would bounce an org-less user
 * straight back into onboarding.
 *
 * @tags @critical
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { registerUser } from "../../helpers/seed.ts";
import type { Browser, Page } from "@playwright/test";

const USER_MENU = "Menu utilisateur";

/**
 * Browser context for a freshly registered user with NO organization: session
 * cookie only, no org/space localStorage. `OrgGate` sends it to onboarding.
 */
async function orglessPage(browser: Browser, cookie: string): Promise<Page> {
  const context = await browser.newContext();
  const value = cookie.match(/better-auth\.session_token=([^;]+)/)?.[1];
  // The whole point of this context is that it is signed in but org-less. A
  // missing token would silently produce an anonymous page and the assertions
  // below would fail against the login screen instead of the onboarding one.
  if (!value) throw new Error(`no better-auth.session_token in cookie: ${cookie}`);
  await context.addCookies([
    { name: "better-auth.session_token", value, domain: "localhost", path: "/" },
  ]);
  return context.newPage();
}

test.describe("Onboarding — account menu", () => {
  test("an org-less user can sign out from the onboarding flow @critical", async ({
    browser,
    request,
  }) => {
    const auth = await registerUser(request);
    const page = await orglessPage(browser, auth.cookie);

    await page.goto("/");
    await expect(page).toHaveURL(/\/onboarding\/create/);

    await page.getByRole("button", { name: USER_MENU }).click();

    // Identity is visible, so a wrong-account user can tell before acting.
    await expect(page.getByText(auth.email)).toBeVisible();
    // Org-scoped entries are hidden: `/preferences` would bounce off OrgGate.
    await expect(page.getByRole("menuitem", { name: "Préférences" })).toHaveCount(0);

    await page.getByRole("menuitem", { name: "Déconnexion" }).click();

    // OSS: the session is cleared and the catch-all route lands on `/login`.
    // OIDC: `startOidcLogout` leaves the SPA for the server-side logout, which
    // returns to `/login` — where `HostedAuthGate` immediately forwards to the
    // hosted page under `/api/`. Both outcomes mean "signed out"; assert the
    // union so the spec passes in whichever mode the server booted in.
    await page.waitForURL((url) => url.pathname === "/login" || url.pathname.startsWith("/api/"), {
      timeout: 15_000,
    });

    await page.context().close();
  });

  test("a user who already has an org can leave onboarding for the app", async ({ authedPage }) => {
    await authedPage.goto("/onboarding/model");

    const backToApp = authedPage.getByRole("link", { name: "Retour à l'application" });
    await expect(backToApp).toBeVisible({ timeout: 15_000 });
    await backToApp.click();

    await expect(authedPage).toHaveURL(/\/$/);
  });
});
