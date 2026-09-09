// SPDX-License-Identifier: Apache-2.0

import type { APIRequestContext } from "@playwright/test";
import type { SpaceRolePreset } from "@appstrate/core/permissions";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createAgent, registerUser, type AuthResult } from "../../helpers/seed.ts";
import { createApiClient, createOrgOnlyClient } from "../../helpers/api-client.ts";

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
    await expect(
      page.getByRole("option", { name: /^(Administrateur de l'espace|Space admin)$/ }),
    ).toBeVisible();
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

/**
 * Invite `user` into `org` and have them accept, so the member exists with the
 * space role the caller names. Every delegated-member test above open-codes
 * this pair of calls; the two below need it with a preset and a run to follow.
 */
async function joinSpace(
  request: APIRequestContext,
  orgOnlyClient: ReturnType<typeof createOrgOnlyClient>,
  orgId: string,
  user: AuthResult,
  spaceAssignments: Array<{ space_id: string; preset_role: SpaceRolePreset }>,
): Promise<void> {
  const invited = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
    email: user.email,
    role: "member",
    space_assignments: spaceAssignments,
  });
  expect(invited.status()).toBe(201);
  const { token } = await invited.json();
  const accepted = await request.post(`/invite/${token}/accept`, {
    headers: { Cookie: user.cookie, Origin: "http://localhost:3000" },
  });
  expect(accepted.status()).toBe(200);
}

test("a runner lands on the agents page, can run, and cannot read what it runs", async ({
  request,
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  const spaceId = browserCtx.org.defaultSpaceId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const agentName = `runner-preset-${Date.now()}`;
  await createAgent(apiClient, scope, agentName);

  const runner = await registerUser(request);
  await joinSpace(request, orgOnlyClient, browserCtx.org.orgId, runner, [
    { space_id: spaceId, preset_role: "runner" },
  ]);

  const context = await createAuthedContext(browser, runner, browserCtx.org.orgId, spaceId);
  const page = await context.newPage();
  try {
    // The sidebar asks for the permission each landing page needs: `agents:run`
    // opens Agents, and `skills:read` — which the preset withholds — hides Skills.
    await page.goto("/agents");
    const navLink = (href: string) => page.locator(`a[data-sidebar="menu-button"][href="${href}"]`);
    await expect(navLink("/agents")).toBeVisible();
    await expect(navLink("/skills")).toHaveCount(0);
    await expect(navLink("/mcp-servers")).toHaveCount(0);
    await expect(navLink("/schedules")).toHaveCount(0);
    await expect(page.getByText(`Test Agent ${agentName}`).first()).toBeVisible();

    // The detail is the SUMMARY read: it launches, and the tabs fed by the
    // manifest, the file explorer and the version history are not offered.
    await page.goto(`/agents/${scope}/${agentName}`);
    await expect(page.getByRole("button", { name: /^(Lancer|Run)$/ }).first()).toBeVisible();
    await expect(page.getByRole("tab", { name: /^(Runs)$/ })).toBeVisible();
    for (const withheld of [/^(À propos|About)$/, /^(Contenu|Content)$/, /^Archives$/]) {
      await expect(page.getByRole("tab", { name: withheld })).toHaveCount(0);
    }

    // A typed URL for a surface the preset withholds is the shared refusal
    // panel, not a page firing a column of 403s.
    await page.goto("/skills");
    await expect(page.getByText(/n'avez pas accès|do not have access/i)).toBeVisible();
  } finally {
    await context.close();
  }
});

test("an operator's runs page and run detail hold only its own runs", async ({
  request,
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  const spaceId = browserCtx.org.defaultSpaceId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const tag = Date.now();
  const agentA = `runs-mine-a-${tag}`;
  const agentB = `runs-mine-b-${tag}`;
  await createAgent(apiClient, scope, agentA);
  await createAgent(apiClient, scope, agentB);

  // Two colleagues in the same space, each an `operator`: `runs:read` is the
  // runs they launched, and `runs:read-all` is what neither holds.
  const [alice, bob] = [await registerUser(request), await registerUser(request)];
  for (const member of [alice, bob]) {
    await joinSpace(request, orgOnlyClient, browserCtx.org.orgId, member, [
      { space_id: spaceId, preset_role: "operator" },
    ]);
  }
  // A launch resolves a model before it creates the run row, so the org needs
  // one. Nothing here reaches the provider: the run fails in the background,
  // and a failed run is still a run these two must not read across.
  const credential = await apiClient.post("/model-provider-credentials", {
    providerId: "anthropic",
    apiKey: "sk-ant-e2e",
  });
  expect(credential.status()).toBe(201);
  const model = await apiClient.post("/models", {
    modelId: "claude-sonnet-4-5-20250929",
    credentialId: (await credential.json()).id,
  });
  expect(model.status()).toBe(201);

  async function launch(member: AuthResult, agent: string): Promise<string> {
    const res = await createApiClient(request, {
      cookie: member.cookie,
      orgId: browserCtx.org.orgId,
      spaceId,
    }).post(`/agents/${scope}/${agent}/run?version=draft`, {});
    expect(res.status()).toBe(201);
    return (await res.json()).id;
  }
  const aliceRun = await launch(alice, agentA);
  const bobRun = await launch(bob, agentB);

  const context = await createAuthedContext(browser, alice, browserCtx.org.orgId, spaceId);
  const page = await context.newPage();
  try {
    await page.goto("/runs");
    await expect(page.locator(`a[href$="/runs/${aliceRun}"]`)).toBeVisible();
    await expect(page.locator(`a[href$="/runs/${bobRun}"]`)).toHaveCount(0);
    // Not a 403: a run the caller may not read is indistinguishable from one
    // that does not exist, so the detail page renders its error state.
    await page.goto(`/agents/${scope}/${agentB}/runs/${bobRun}`);
    await expect(page.getByText(/Une erreur est survenue|An error occurred/)).toBeVisible();
  } finally {
    await context.close();
  }
});
