// SPDX-License-Identifier: Apache-2.0

/**
 * Browser E2E for leaving an organization and confirming a member's removal.
 *
 * After the leave, the SPA must step out of the org without a reload: onto
 * another org the user still belongs to, or into onboarding when none is
 * left — and never keep the gone org id in `appstrate_current_org`.
 *
 * @tags @critical
 */

import type { APIRequestContext, Page } from "@playwright/test";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createIntegration, createOrg, registerUser, type AuthResult } from "../../helpers/seed.ts";
import { createApiClient, createOrgOnlyClient, type ApiClient } from "../../helpers/api-client.ts";
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
    // A confirmation is an alert dialog, apart from the settings dialog behind it.
    .getByRole("alertdialog")
    .getByRole("button", { name: /Quitter l'organisation|Leave organization/ })
    .click();
  expect((await left).status()).toBe(204);
}

const storedOrgId = (page: Page) =>
  page.evaluate(() => localStorage.getItem("appstrate_current_org"));

for (const outcome of ["succeeds", "fails"] as const) {
  test(`removal waits for the offline departure preview until it ${outcome}`, async ({
    request,
    authedPage: page,
    browserCtx,
    orgOnlyClient,
  }) => {
    const orgId = browserCtx.org.orgId;
    const member = await registerUser(request, { name: "Departing Member" });
    await joinAsMember(request, orgOnlyClient, orgId, member);
    await page.goto("/org-settings/members");
    const actions = page.getByRole("button", { name: /actions.*Departing Member/i });
    await expect(actions).toBeVisible();

    const impactUrl = `**/api/orgs/${orgId}/members/${member.userId}/departure-impact`;
    const release = Promise.withResolvers<void>();
    await page.route(impactUrl, async (route) => {
      await release.promise;
      if (outcome === "succeeds") return route.continue();
      await route.fulfill({ status: 403, json: { code: "forbidden" } });
    });

    const dialog = page.getByRole("alertdialog");
    const remove = dialog.getByRole("button", { name: /^(Retirer|Remove)$/ });
    try {
      await page.context().setOffline(true);
      await actions.click();
      await page.getByRole("menuitem", { name: /^(Retirer|Remove)$/ }).click();
      await expect(remove).toBeDisabled();

      const resumed = page.waitForRequest(impactUrl);
      await page.context().setOffline(false);
      await resumed;
      await expect(remove).toBeDisabled();
    } finally {
      release.resolve();
    }

    const message =
      outcome === "succeeds"
        ? /Aucune planification|No team-space schedule/
        : /Impossible de savoir|Could not tell/;
    await expect(dialog.getByText(message)).toBeVisible();
    await expect(remove).toBeEnabled();
  });
}

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
      // A confirmation is an alert dialog, apart from the settings dialog behind it.
      .getByRole("alertdialog")
      .getByRole("button", { name: /^(Supprimer|Delete)$/ })
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

test("a member's shared connection can be replaced before removal", async ({
  request,
  authedPage: page,
  apiClient,
  browserCtx,
  orgOnlyClient,
}) => {
  const { orgId, orgSlug, defaultSpaceId } = browserCtx.org;
  const departing = await registerUser(request, { name: "Departing connection owner" });
  const actor = await registerUser(request, { name: "Schedule actor" });
  for (const member of [departing, actor])
    await joinAsMember(request, orgOnlyClient, orgId, member);
  const scope = `@${orgSlug}`;
  const integration = (await createIntegration(apiClient, scope, "service")).id;
  async function connect(client: ApiClient) {
    const connected = await client.post(`/integrations/${integration}/auths/api/connect/fields`, {
      credentials: { api_key: "test-credential" },
    });
    expect(connected.status(), await connected.text()).toBe(200);
    const { id } = await connected.json();
    return String(id);
  }
  async function sharedConnection(client: ApiClient) {
    const id = await connect(client);
    const shared = await client.put(`/me/connections/${id}/shares/${defaultSpaceId}`);
    expect(shared.ok(), await shared.text()).toBe(true);
    return id;
  }
  const old = await sharedConnection(
    createApiClient(request, { cookie: departing.cookie, orgId, spaceId: defaultSpaceId }),
  );
  const replacement = await sharedConnection(apiClient);
  const privateConnection = await connect(apiClient);
  expect(privateConnection).not.toBe(replacement);
  // The agent now uses an unauthenticated integration. Only the schedule still needs v0.1.
  const packagePath = `/packages/integrations/${integration}`;
  const detail = await apiClient.get(packagePath);
  const { manifest } = await detail.json();
  delete manifest.auths;
  const edited = await apiClient.patch(
    packagePath,
    {
      manifest: {
        ...manifest,
        schema_version: "0.3",
        source: {
          kind: "remote",
          remote: { url: "https://example.invalid/mcp", transport: "streamable-http" },
        },
      },
    },
    { "If-Match": detail.headers()["etag"]! },
  );
  expect(edited.ok(), await edited.text()).toBe(true);
  const published = await apiClient.post(`${packagePath}/versions`, { version: "2.0.0" });
  expect(published.ok(), await published.text()).toBe(true);
  const agent = `${scope}/scheduled`;
  const created = await apiClient.post("/packages/agents", {
    manifest: {
      schema_version: "0.2",
      type: "agent",
      version: "1.0.0",
      name: agent,
      display_name: "Scheduled",
      description: "Schedule test",
      dependencies: { integrations: { [integration]: "^2.0.0" } },
      integrations_configuration: { [integration]: { tools: ["*"] } },
    },
    content: "Use the selected connection.",
  });
  expect(created.ok(), await created.text()).toBe(true);
  const ordinary = await apiClient.get(`/agents/${agent}/connection-readiness?version=published`);
  expect((await ordinary.json()).integrations).toContainEqual(
    expect.objectContaining({
      integration_package_id: integration,
      connection_required: false,
    }),
  );
  const schedule = await apiClient.post(`/agents/${agent}/schedules`, {
    name: "Team schedule",
    cron_expression: "0 9 * * *",
    actor: { userId: actor.userId },
    dependency_overrides: { [integration]: "0.1.0" },
    connection_overrides: { [integration]: [old] },
  });
  expect(schedule.status(), await schedule.text()).toBe(201);
  const { id } = await schedule.json();
  await page.goto("/org-settings/members");
  const openRemoval = async () => {
    await page.getByRole("button", { name: /actions.*Departing connection owner/i }).click();
    await page.getByRole("menuitem", { name: /^(Retirer|Remove)$/ }).click();
  };
  await openRemoval();
  await page.getByRole("link", { name: /Choisir une connexion|Choose a connection/ }).click();
  const original = page.getByTestId(`sched-choice-pick-option-${old}`);
  await expect(original).toBeChecked();
  await expect(page.getByTestId(`sched-choice-pick-option-${privateConnection}`)).toHaveCount(0);
  await original.click();
  await page.getByTestId(`sched-choice-pick-option-${replacement}`).click();
  const saved = page.waitForResponse(
    (r) => r.request().method() === "PATCH" && r.url().endsWith(`/api/schedules/${id}`),
  );
  await page.getByRole("button", { name: /^(Enregistrer|Save)$/ }).click();
  expect((await saved).ok()).toBe(true);
  await page.goto("/org-settings/members");
  await openRemoval();
  await expect(page.getByText(/Aucune planification|No .*schedule/i)).toBeVisible();
  const removed = page.waitForResponse(
    (r) =>
      r.request().method() === "DELETE" &&
      r.url().endsWith(`/api/orgs/${orgId}/members/${departing.userId}`),
  );
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^(Retirer|Remove)$/ })
    .click();
  expect((await removed).ok()).toBe(true);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  expect(await (await apiClient.get(`/schedules/${id}`)).json()).toMatchObject({
    enabled: true,
    userId: actor.userId,
    connection_overrides: { [integration]: [replacement] },
  });
});
