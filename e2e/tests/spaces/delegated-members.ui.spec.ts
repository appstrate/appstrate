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
    await expect(dialog.locator("#space-member-external")).toHaveCount(0);
    const email = dialog.locator("#space-member-email");
    await email.fill("not-an-email");
    await email.press("Enter");
    await expect(email).toHaveAttribute("aria-invalid", "true");
    await expect(dialog.getByRole("alert")).toBeVisible();
    await email.fill(target.email.toUpperCase());
    await dialog.locator("#space-member-role").click();
    await expect(page.getByRole("option", { name: /^(Administrateur|Admin)$/ })).toBeVisible();
    await page.getByRole("option", { name: /^(Lecteur|Viewer)$/ }).click();
    const added = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/spaces/${spaceId}/members`),
    );
    await email.press("Enter");
    expect((await added).status()).toBe(201);
    await expect(
      page.getByRole("row").filter({ hasText: target.email }).getByRole("combobox"),
    ).toContainText(/Lecteur|Viewer/);
  } finally {
    await context.close();
  }
});

test("resetting an explicit viewer explains and confirms the default operator access", async ({
  request,
  authedPage: page,
  browserCtx,
  orgOnlyClient,
}) => {
  const target = await registerUser(request);
  const spaceId = browserCtx.org.defaultSpaceId;
  const invited = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
    email: target.email,
    role: "member",
    space_assignments: [{ space_id: spaceId, preset_role: "viewer" }],
  });
  expect(invited.status()).toBe(201);
  const { token } = await invited.json();
  expect(
    (
      await request.post(`/invite/${token}/accept`, {
        headers: { Cookie: target.cookie, Origin: "http://localhost:3000" },
      })
    ).status(),
  ).toBe(200);
  await page.goto("/org-settings/space/members");
  const row = page.getByRole("row").filter({ hasText: target.email });
  await expect(row.getByRole("combobox")).toContainText(/Lecteur|Viewer/);
  await row
    .getByRole("button", { name: /Rétablir le rôle par défaut|Restore default role/i })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/Opérateur|Operator/);
  await expect(dialog).toContainText(/davantage de permissions|more permissions/i);
  const before = await orgOnlyClient.get(`/spaces/${spaceId}/members`);
  expect(
    (await before.json()).data.find(
      (member: { userId: string }) => member.userId === target.userId,
    ),
  ).toMatchObject({ source: "explicit", role: { key: "viewer" } });
  await dialog
    .getByRole("button", { name: /Rétablir le rôle par défaut|Restore default role/i })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(row.getByRole("combobox")).toContainText(/Opérateur|Operator/);
  const after = await orgOnlyClient.get(`/spaces/${spaceId}/members`);
  expect(
    (await after.json()).data.find((member: { userId: string }) => member.userId === target.userId),
  ).toMatchObject({ source: "open_space", role: { key: "operator" } });
});

test("space settings retain edits and expose a forbidden save response", async ({
  authedPage: page,
  browserCtx,
  orgOnlyClient,
}) => {
  const path = `/api/spaces/${browserCtx.org.defaultSpaceId}`;
  await page.route(`**${path}`, (route) =>
    route.request().method() === "PATCH"
      ? route.fulfill({
          status: 403,
          contentType: "application/problem+json",
          body: JSON.stringify({
            title: "Forbidden",
            detail: "Space update denied for this role",
            status: 403,
          }),
        })
      : route.continue(),
  );
  await page.goto("/org-settings/space/general");
  const name = page.locator("#space-name");
  await name.fill("Unpersisted name");
  await page.locator('form button[type="submit"]').click();
  await expect(
    page.getByRole("alert").filter({ hasText: "Space update denied for this role" }),
  ).toBeVisible();
  await expect(name).toHaveValue("Unpersisted name");
  const persisted = await orgOnlyClient.get(`/spaces/${browserCtx.org.defaultSpaceId}`);
  expect((await persisted.json()).name).not.toBe("Unpersisted name");
});

test("organization administrators invite an external guest directly into the selected space", async ({
  authedPage: page,
  browserCtx,
  orgOnlyClient,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/org-settings/space/members");
  await page.getByTestId("add-space-member-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#space-member-external").click();
  const address = `space-guest-${Date.now()}@test.com`;
  await dialog.locator("#space-member-email").fill(address);
  await dialog.locator("#space-member-role").click();
  await page.getByRole("option", { name: /^(Lecteur|Viewer)$/ }).click();
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${browserCtx.org.orgId}/members`),
  );
  await dialog.locator("#space-member-email").press("Enter");
  const response = await submitted;
  expect(response.status()).toBe(201);
  expect(await response.json()).toMatchObject({
    email: address,
    role: "guest",
    space_assignments: [{ space_id: browserCtx.org.defaultSpaceId, preset_role: "viewer" }],
  });
  await expect(dialog.getByRole("button", { name: /Copier le lien|Copy link/i })).toBeVisible();
  const manage = dialog.getByRole("link", {
    name: /Gérer les invitations|Manage pending invitations/i,
  });
  await expect(manage).toHaveAttribute("href", "/org-settings/members");
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
  const persisted = await orgOnlyClient.get(`/orgs/${browserCtx.org.orgId}`);
  expect(
    (await persisted.json()).invitations.find((item: { email: string }) => item.email === address),
  ).toMatchObject({
    role: "guest",
    space_assignments: [{ space_id: browserCtx.org.defaultSpaceId, preset_role: "viewer" }],
  });
  await page.keyboard.press("Escape");
  await page.getByTestId("add-space-member-button").click();
  await expect(dialog.locator("#space-member-existing")).toHaveAttribute("aria-checked", "true");
  await expect(dialog.getByRole("button", { name: /Copier le lien|Copy link/i })).toHaveCount(0);
  await dialog.locator("#space-member-external").click();
  await expect(dialog.locator("#space-member-email")).toHaveValue("");
});

test("a pending guest invitation shows in the space and a second invite for the address is refused", async ({
  authedPage: page,
  browserCtx,
  orgOnlyClient,
}) => {
  const address = `pending-guest-${Date.now()}@test.com`;
  const created = await orgOnlyClient.post(`/orgs/${browserCtx.org.orgId}/members`, {
    email: address,
    role: "guest",
    space_assignments: [{ space_id: browserCtx.org.defaultSpaceId, preset_role: "viewer" }],
  });
  expect(created.status()).toBe(201);
  const invitation = await created.json();
  await page.goto("/org-settings/space/members");
  const card = page.locator(`[data-invitation-id="${invitation.id}"]`);
  await expect(card).toContainText(address);
  await expect(card).toContainText(/Invitation en attente|Pending invitation/);
  await expect(card).toContainText(/Lecteur|Viewer/);
  await expect(page.getByRole("row").filter({ hasText: address })).toHaveCount(0);

  await page.getByTestId("add-space-member-button").click();
  const dialog = page.getByRole("dialog");
  await dialog.locator("#space-member-external").click();
  await dialog.locator("#space-member-email").fill(address.toUpperCase());
  const submitted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/api/orgs/${browserCtx.org.orgId}/members`),
  );
  await dialog.locator("#space-member-email").press("Enter");
  const response = await submitted;
  expect(response.status()).toBe(409);
  expect(await response.json()).toMatchObject({
    code: "invitation_already_pending",
    invitation_id: invitation.id,
  });
  const alert = dialog.getByRole("alert");
  await expect(alert).toContainText(/déjà en attente|already pending/i);
  await expect(
    alert.getByRole("link", { name: /Gérer les invitations|Manage pending invitations/i }),
  ).toHaveAttribute("href", "/org-settings/members");
  await expect(dialog.getByRole("button", { name: /Copier le lien|Copy link/i })).toHaveCount(0);

  const persisted = await orgOnlyClient.get(`/orgs/${browserCtx.org.orgId}`);
  const pending = (await persisted.json()).invitations.filter(
    (item: { email: string }) => item.email === address,
  );
  expect(pending).toHaveLength(1);
  expect(pending[0]).toMatchObject({ id: invitation.id, token: invitation.token });
});
