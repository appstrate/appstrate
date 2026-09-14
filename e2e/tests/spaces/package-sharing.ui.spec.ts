// SPDX-License-Identifier: Apache-2.0

/**
 * Sharing a package with a guest, end to end (RBAC spec §6.10).
 *
 * What a route test cannot show: that the two halves of the flow actually meet
 * in the SPA. An administrator shares an agent from the package page's own
 * dialog, and the guest — an external identity with no reach into any space —
 * finds it under "Partagé avec moi" in their agent list and adds it to their own
 * space with one button — the same `POST /api/spaces/{spaceId}/packages` an
 * admin uses from the library, because there is only one door. Only then does
 * the platform let them launch it, and the administrator still cannot see
 * inside that space.
 *
 * What the recipient then runs is the author's LATEST published version, not a
 * frozen copy and never the draft: the tail of this test publishes a second
 * version and reads it back off the next run the guest starts. The launch is
 * asserted on the created run resource (its `version_ref`) rather than on a
 * terminal status: the org gets a model so the launch reaches the run row, and
 * nothing here reaches the provider — the run fails in the background.
 */

import type { APIRequestContext } from "@playwright/test";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createAgent, registerUser, type AuthResult } from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";
import { selectOption } from "../../helpers/radix.ts";
import { E2E_BASE_URL } from "../../helpers/base-url.ts";

/** The caller's own personal space id, from the listing that also repairs it. */
async function personalSpaceOf(
  request: APIRequestContext,
  cookie: string,
  orgId: string,
): Promise<string> {
  const res = await request.get("/api/spaces", { headers: { Cookie: cookie, "X-Org-Id": orgId } });
  expect(res.status()).toBe(200);
  const own = ((await res.json()).data as { id: string; personal: boolean }[]).filter(
    (space) => space.personal,
  );
  expect(own).toHaveLength(1);
  return own[0]!.id;
}

test("an admin shares an agent with a guest, who adds it to their space and may then run it", async ({
  request,
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `shared-${Date.now().toString(36)}`;

  // The agent lives in the organization's default space — its home, and where
  // the sharing authority (`agents:share`) is held. Away from its home a
  // package runs its latest published version and nothing else, so an offer of
  // a package with nothing published is an offer of nothing (409
  // `package_has_no_version`): `POST /packages/agents` already mints the
  // manifest's `0.1.0` (`createVersionSafe`), so republishing it here would be
  // a 409 `no_changes`, not a second version.
  await createAgent(apiClient, scope, name);

  // A launch resolves a model BEFORE it creates the run row (400
  // `model_not_configured` otherwise), and this test reads `version_ref` off
  // that row. Nothing here reaches the provider: the run is accepted and then
  // fails in the background, which is all the version assertions need.
  const credential = await apiClient.post("/model-provider-credentials", {
    providerId: "anthropic",
    apiKey: "sk-ant-e2e",
  });
  expect(credential.status(), await credential.text()).toBe(201);
  const model = await apiClient.post("/models", {
    modelId: "claude-sonnet-4-5-20250929",
    credentialId: (await credential.json()).id,
  });
  expect(model.status(), await model.text()).toBe(201);

  // A GUEST: invited for exactly one thing, with no space assignment. Named
  // distinctly on purpose — the member picker below is a Radix listbox driven
  // by typeahead on the option's FIRST word, and every other seeded user in
  // this organization is an "E2E User …", so a shared first word would commit
  // whichever of them the list happened to highlight.
  const guest: AuthResult = await registerUser(request, {
    name: `Guest ${Date.now().toString(36)}`,
  });
  const invited = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
    email: guest.email,
    role: "guest",
    space_assignments: [],
  });
  expect(invited.status(), await invited.text()).toBe(201);
  const accepted = await request.post(`/invite/${(await invited.json()).token}/accept`, {
    headers: { Cookie: guest.cookie, Origin: E2E_BASE_URL },
  });
  expect(accepted.status()).toBe(200);

  const guestSpaceId = await personalSpaceOf(request, guest.cookie, orgId);
  const guestClient = createApiClient(request, {
    cookie: guest.cookie,
    orgId,
    spaceId: guestSpaceId,
  });

  // Before the share the guest cannot even see it.
  expect((await guestClient.get(`/packages/agents/${scope}/${name}`)).status()).toBe(404);

  // ── The admin shares it, from the package page's own dialog ──
  const adminPage = await (
    await createAuthedContext(browser, browserCtx.auth, orgId, browserCtx.org.defaultSpaceId)
  ).newPage();
  try {
    await adminPage.goto(`/agents/${scope}/${name}`);
    // The actions dropdown, then the share item it gates on `home_shareable`.
    await adminPage.getByTestId("package-actions-trigger").first().click();
    await adminPage.getByRole("menuitem", { name: /Partager|Share/ }).click();
    // The option's label is the member's `displayName`, which the sign-up hook
    // seeds from `user.name` (`profiles.displayName = user.name || user.email`)
    // — so it is the NAME on the wire here, not the address.
    await selectOption(adminPage, "share-user", guest.name);
    const shared = adminPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/shares") === true,
    );
    await adminPage.getByRole("button", { name: /^(Partager|Share)$/ }).click();
    expect((await shared).status()).toBe(200);
  } finally {
    await adminPage.context().close();
  }

  // ── The guest finds it and adds it to their own space ──
  // It is READABLE now, and still not runnable: offered is not activated.
  // No `?version=` selector anywhere in this test but the negative control
  // below — an omitted selector is what resolves the latest published version.
  expect((await guestClient.get(`/packages/agents/${scope}/${name}`)).status()).toBe(200);
  expect((await guestClient.post(`/agents/${scope}/${name}/run`, {})).status()).toBe(404);

  const guestPage = await (
    await createAuthedContext(browser, guest, orgId, guestSpaceId)
  ).newPage();
  try {
    expect((await guestClient.get("/library")).status()).toBe(403);
    await guestPage.goto("/library");
    await expect(
      guestPage.getByText(/Vous n'avez pas accès|You do not have access/).first(),
    ).toBeVisible();
    await guestPage.goto("/agents");
    await expect(guestPage.getByText(/Partagé avec moi|Shared with me/)).toBeVisible();
    // THE door, and the only one: adding an offer to one's own space is the
    // same route the library's checkboxes call for a team space.
    const installed = guestPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/spaces/${guestSpaceId}/packages`),
    );
    await guestPage.getByRole("button", { name: /Ajouter à mon espace|Add to my space/ }).click();
    expect((await installed).status()).toBe(201);
  } finally {
    await guestPage.context().close();
  }

  // Installed in the guest's own space, and the run route no longer refuses
  // them: the execution gate is the installation, which is now theirs.
  const placed = await guestClient.get(`/spaces/${guestSpaceId}/packages`);
  expect(placed.status()).toBe(200);
  expect(
    ((await placed.json()).data as { packageId: string }[]).map((row) => row.packageId),
  ).toContain(`${scope}/${name}`);
  const firstRun = await guestClient.post(`/agents/${scope}/${name}/run`, {});
  expect(firstRun.status(), await firstRun.text()).toBe(201);
  expect((await firstRun.json()).version_ref).toBe("0.1.0");

  // The negative control the pin concealed: the draft is the author's working
  // copy. Installing the package in your space does not make it yours to run —
  // this exact call answered 404 before the share, and the moment it stopped
  // doing so it would have executed the admin's uncommitted bytes.
  const guestDraft = await guestClient.post(`/agents/${scope}/${name}/run?version=draft`, {});
  expect(guestDraft.status(), await guestDraft.text()).toBe(403);
  expect((await guestDraft.json()).code).toBe("draft_not_writable");

  // The author ships a fix. Nobody accepts anything again, nobody re-pins:
  // the next run the guest starts carries the new version.
  const republished = await apiClient.post(`/packages/agents/${scope}/${name}/versions`, {
    version: "0.2.0",
  });
  expect(republished.status(), await republished.text()).toBe(201);
  const secondRun = await guestClient.post(`/agents/${scope}/${name}/run`, {});
  expect(secondRun.status(), await secondRun.text()).toBe(201);
  expect((await secondRun.json()).version_ref).toBe("0.2.0");

  // ── And the admin sees nothing of what happens in there ──
  // Two runs exist by now, both in the guest's personal space; the admin's own
  // listing of the agent they authored still shows none of them.
  const adminSpaceProbe = await request.get(`/api/spaces/${guestSpaceId}`, {
    headers: { Cookie: browserCtx.auth.cookie, "X-Org-Id": orgId },
  });
  expect(adminSpaceProbe.status()).toBe(404);
  const adminRuns = await apiClient.get(`/agents/${scope}/${name}/runs`);
  expect(adminRuns.status()).toBe(200);
  expect((await adminRuns.json()).data ?? []).toHaveLength(0);
});

test("an offer opens in its destination space and accepting refreshes an already visited agent list", async ({
  request,
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `offered-${Date.now().toString(36)}`;
  const homeId = await personalSpaceOf(request, browserCtx.auth.cookie, orgId);
  const authorClient = createApiClient(request, {
    cookie: browserCtx.auth.cookie,
    orgId,
    spaceId: homeId,
  });
  await createAgent(authorClient, scope, name);
  const member = await registerUser(request);
  const invite = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
    email: member.email,
    role: "member",
  });
  expect(invite.status()).toBe(201);
  const joined = await request.post(`/invite/${(await invite.json()).token}/accept`, {
    headers: { Cookie: member.cookie, Origin: E2E_BASE_URL },
  });
  expect(joined.status()).toBe(200);
  const personalId = await personalSpaceOf(request, member.cookie, orgId);
  const shared = await authorClient.post(`/packages/${scope}/${name}/shares`, {
    target: { kind: "user", user_id: member.userId },
  });
  expect(shared.status(), await shared.text()).toBe(200);

  const page = await (await createAuthedContext(browser, member, orgId, personalId)).newPage();
  try {
    await page.goto("/agents");
    const detailResponse = page.waitForResponse((response) =>
      response.url().includes(`/api/packages/agents/${scope}/${name}`),
    );
    await page.getByRole("link", { name: `Test Agent ${name}`, exact: true }).click();
    const detail = await detailResponse;
    expect(detail.status()).toBe(200);
    expect(detail.request().headers()["x-space-id"]).toBe(personalId);
    await expect(page).toHaveURL(new RegExp(`/agents/${scope}/${name}$`));

    // Stay in one SPA session: a reload would discard the cache under test.
    await page.locator('a[href="/agents"]').first().click();
    await expect(page.getByText(/Aucun agent disponible|No agents available/)).toBeVisible();
    await page.getByTestId("org-switcher-button").click();
    await expect(page.locator('a[href="/library"]')).toHaveCount(0);
    await page.locator('a[href="/space/packages"]').first().click();
    const accepted = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/spaces/${personalId}/packages`),
    );
    await page.getByRole("button", { name: /Ajouter à mon espace|Add to my space/ }).click();
    expect((await accepted).status()).toBe(201);
    await page.locator('a[href="/agents"]').first().click();
    await expect(page.getByText(`Test Agent ${name}`, { exact: true }).first()).toBeVisible();
  } finally {
    await page.context().close();
  }
});

test("a draft-only agent is published from the share dialog itself, then offered", async ({
  request,
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `unpublished-${Date.now().toString(36)}`;

  // `POST /packages/agents` mints the manifest's `0.1.0` on creation, so the
  // draft-only shape this test needs is made by deleting it again — the same
  // state an author reaches when that best-effort snapshot was skipped
  // (an incomplete manifest at creation time) and they never published since.
  await createAgent(apiClient, scope, name);
  const dropped = await apiClient.delete(`/packages/agents/${scope}/${name}/versions/0.1.0`);
  expect(dropped.status(), await dropped.text()).toBe(204);

  const member = await registerUser(request, { name: `Recipient ${Date.now().toString(36)}` });
  const invite = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
    email: member.email,
    role: "member",
  });
  expect(invite.status()).toBe(201);
  const joined = await request.post(`/invite/${(await invite.json()).token}/accept`, {
    headers: { Cookie: member.cookie, Origin: E2E_BASE_URL },
  });
  expect(joined.status()).toBe(200);

  const page = await (
    await createAuthedContext(browser, browserCtx.auth, orgId, browserCtx.org.defaultSpaceId)
  ).newPage();
  try {
    await page.goto(`/agents/${scope}/${name}`);
    await page.getByTestId("package-actions-trigger").first().click();
    await page.getByRole("menuitem", { name: /Partager|Share/ }).click();
    await selectOption(page, "share-user", member.name);

    // The offer is refused for want of a version, and the dialog says so in
    // place rather than sending the author off to the Versions tab.
    const refused = page.waitForResponse(
      (response) => response.request().method() === "POST" && response.url().includes("/shares"),
    );
    await page.getByRole("button", { name: /^(Partager|Share)$/ }).click();
    expect((await refused).status()).toBe(409);
    await expect(page.getByTestId("share-needs-version")).toBeVisible();

    // One button does both, in the order that makes the second succeed.
    const published = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/versions") === true,
    );
    const offered = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/shares") &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: /Publier et partager|Publish and share/ }).click();
    expect((await published).status()).toBe(201);
    expect((await offered).status()).toBe(200);
    await expect(page.getByTestId("share-needs-version")).toHaveCount(0);
  } finally {
    await page.context().close();
  }

  // The recipient really has the offer, and adding it to their own space needs
  // no grant — owning the space is the authorization.
  const personalId = await personalSpaceOf(request, member.cookie, orgId);
  const memberClient = createApiClient(request, {
    cookie: member.cookie,
    orgId,
    spaceId: personalId,
  });
  const added = await memberClient.post(`/spaces/${personalId}/packages`, {
    packageId: `${scope}/${name}`,
  });
  expect(added.status(), await added.text()).toBe(201);
});

test("a non-admin builder manages a team offer from the space package view", async ({
  request,
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const spaceId = browserCtx.org.defaultSpaceId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `team-offer-${Date.now().toString(36)}`;
  const author = createApiClient(request, {
    cookie: browserCtx.auth.cookie,
    orgId,
    spaceId: await personalSpaceOf(request, browserCtx.auth.cookie, orgId),
  });
  await createAgent(author, scope, name);
  const member = await registerUser(request);
  const invite = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
    email: member.email,
    role: "guest",
    space_assignments: [{ space_id: spaceId, preset_role: "builder" }],
  });
  expect(invite.status()).toBe(201);
  expect(
    (
      await request.post(`/invite/${(await invite.json()).token}/accept`, {
        headers: { Cookie: member.cookie, Origin: E2E_BASE_URL },
      })
    ).status(),
  ).toBe(200);
  expect(
    (
      await author.post(`/packages/${scope}/${name}/shares`, {
        target: { kind: "space", space_id: spaceId },
      })
    ).status(),
  ).toBe(200);
  const page = await (await createAuthedContext(browser, member, orgId, spaceId)).newPage();
  try {
    await page.goto("/space/packages");
    const installed = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/spaces/${spaceId}/packages`),
    );
    await page.getByRole("button", { name: /Installer dans|Install in/ }).click();
    expect((await installed).status()).toBe(201);
    const row = page.getByRole("row").filter({ hasText: `Test Agent ${name}` });
    await expect(row.getByRole("checkbox")).toBeChecked();
    const removed = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes(`/packages/${scope}/${name}`),
    );
    await row.getByRole("checkbox").click();
    expect((await removed).status()).toBe(204);
    await expect(page.getByRole("button", { name: /Installer dans|Install in/ })).toBeVisible();
  } finally {
    await page.context().close();
  }
});
