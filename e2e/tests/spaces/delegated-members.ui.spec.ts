// SPDX-License-Identifier: Apache-2.0

import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { registerUser, type AuthResult } from "../../helpers/seed.ts";

test("Guest space admins assign preset roles by email without an organization directory", async ({
  request,
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const spaceId = browserCtx.org.defaultSpaceId;
  const guest = await registerUser(request);
  const target = await registerUser(request);
  async function join(user: AuthResult, role: "guest" | "member") {
    const invited = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
      email: user.email,
      role,
      space_assignments: role === "guest" ? [{ space_id: spaceId, preset_role: "admin" }] : [],
    });
    expect(invited.status()).toBe(201);
    const { token } = await invited.json();
    const accepted = await request.post(`/invite/${token}/accept`, {
      headers: { Cookie: user.cookie, Origin: "http://localhost:3000" },
    });
    expect(accepted.status()).toBe(200);
  }
  await join(guest, "guest");
  await join(target, "member");
  const context = await createAuthedContext(browser, guest, browserCtx.org.orgId, spaceId);
  const page = await context.newPage();
  try {
    await page.goto("/org-settings/space/members");
    await page.getByTestId("add-space-member-button").click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.locator("#space-member-user")).toHaveCount(0);
    await dialog.locator("#space-member-email").fill(target.email.toUpperCase());
    await dialog.locator("#space-member-role").click();
    await expect(page.getByRole("option", { name: /^(Administrateur|Admin)$/ })).toBeVisible();
    await page.getByRole("option", { name: /^(Lecteur|Viewer)$/ }).click();
    const added = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/spaces/${spaceId}/members`),
    );
    await dialog.getByRole("button", { name: /^(Ajouter|Add)$/ }).click();
    expect((await added).status()).toBe(201);
    await expect(
      page.getByRole("row").filter({ hasText: target.email }).getByRole("combobox"),
    ).toContainText(/Lecteur|Viewer/);
  } finally {
    await context.close();
  }
});
