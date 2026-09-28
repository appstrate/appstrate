// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E for leaving an organization from Settings → General.
 *
 * After the leave, the SPA must step out of the org without a reload: onto
 * another org the user still belongs to, or into onboarding when none is
 * left — and never keep the gone org id in `appstrate_current_org`.
 *
 * @tags @critical
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createOrg, registerUser, type AuthResult } from "../../helpers/seed.ts";
import { createOrgOnlyClient } from "../../helpers/api-client.ts";
import { E2E_BASE_URL } from "../../helpers/base-url.ts";

/** Invite `user` into the org as a plain member and have them accept. */
async function joinAsMember(
  request: APIRequestContext,
  orgOnlyClient: ReturnType<typeof createOrgOnlyClient>,
  orgId: string,
  user: AuthResult,
): Promise<void> {
  const invited = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
    email: user.email,
    role: "member",
  });
  expect(invited.status()).toBe(201);
  const { token } = await invited.json();
  const accepted = await request.post(`/invite/${token}/accept`, {
    headers: { Cookie: user.cookie, Origin: E2E_BASE_URL },
  });
  expect(accepted.status()).toBe(200);
}

/** Leave the current org through the danger-zone card and its confirmation. */
async function leaveFromSettings(page: Page, orgId: string): Promise<void> {
  await page.goto("/org-settings/general");
  await page.getByTestId("leave-org-button").click();
  const left = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" && response.url().endsWith(`/api/orgs/${orgId}/leave`),
  );
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Quitter l'organisation|Leave organization/ })
    .click();
  expect((await left).status()).toBe(204);
}

const storedOrgId = (page: Page) =>
  page.evaluate(() => localStorage.getItem("appstrate_current_org"));

test.describe("Leaving an organization", () => {
  test("a member leaves and lands on their other organization", async ({
    request,
    browser,
    browserCtx,
    orgOnlyClient,
  }) => {
    const orgId = browserCtx.org.orgId;
    const member = await registerUser(request);
    const own = await createOrg(request, member.cookie);
    await joinAsMember(request, orgOnlyClient, orgId, member);

    const context = await createAuthedContext(
      browser,
      member,
      orgId,
      browserCtx.org.defaultSpaceId,
    );
    const page = await context.newPage();
    try {
      await leaveFromSettings(page, orgId);

      await page.waitForURL((url) => !url.pathname.startsWith("/org-settings"));
      await expect.poll(() => storedOrgId(page)).toBe(own.orgId);

      const orgs = await request.get("/api/orgs", { headers: { Cookie: member.cookie } });
      const ids = ((await orgs.json()).data as Array<{ id: string }>).map((o) => o.id);
      expect(ids).toEqual([own.orgId]);
    } finally {
      await context.close();
    }
  });

  test("leaving the last organization lands on onboarding", async ({
    request,
    browser,
    browserCtx,
    orgOnlyClient,
  }) => {
    const orgId = browserCtx.org.orgId;
    const member = await registerUser(request);
    await joinAsMember(request, orgOnlyClient, orgId, member);

    const context = await createAuthedContext(
      browser,
      member,
      orgId,
      browserCtx.org.defaultSpaceId,
    );
    const page = await context.newPage();
    try {
      await leaveFromSettings(page, orgId);

      await page.waitForURL(/\/onboarding\/(create|waiting)/);
      await expect.poll(() => storedOrgId(page)).toBeNull();
    } finally {
      await context.close();
    }
  });

  test("an owner deletes an organization and lands on their other organization", async ({
    request,
    authedPage: page,
    browserCtx,
  }) => {
    const orgId = browserCtx.org.orgId;
    const other = await createOrg(request, browserCtx.auth.cookie);

    await page.goto("/org-settings/general");
    await page.getByTestId("delete-org-button").click();
    const deleted = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" && response.url().endsWith(`/api/orgs/${orgId}`),
    );
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^(Confirmer|Confirm)$/ })
      .click();
    expect((await deleted).status()).toBe(204);

    // No reload: the SPA itself moves off the gone org.
    await page.waitForURL((url) => !url.pathname.startsWith("/org-settings"));
    await expect.poll(() => storedOrgId(page)).toBe(other.orgId);
  });

  test("the sole owner and member cannot leave and is pointed to delete", async ({
    authedPage: page,
  }) => {
    await page.goto("/org-settings/general");
    const leave = page.getByTestId("leave-org-button");
    await expect(leave).toBeDisabled();
    await expect(leave).toHaveAccessibleDescription(/unique membre|only member/i);
  });
});
