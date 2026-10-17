// SPDX-License-Identifier: Apache-2.0

/**
 * Sharing a package with a guest, end to end (RBAC spec §6.10).
 *
 * What a route test cannot show: that the two halves of the flow actually meet
 * in the SPA. An administrator shares an agent from the package page's own
 * dialog, and the guest — an external identity with no reach into any space —
 * finds it in their own space's package list as a PLACEMENT switched off (the
 * admin cannot activate in someone else's personal space), and switches it on
 * with the same `POST
 * /api/spaces/{spaceId}/packages` an admin uses from the library, because there
 * is only one door. Only then does the platform let them launch it, and the
 * administrator still cannot see inside that space.
 *
 * What the recipient then runs is the author's LATEST published version, not a
 * frozen copy and never the draft: the tail of this test publishes a second
 * version and reads it back off the next run the guest starts. The launch is
 * asserted on the created run resource (its `version_ref`) rather than on a
 * terminal status: the org gets a model so the launch reaches the run row, and
 * nothing here reaches the provider — the run fails in the background.
 */

import type { APIRequestContext, Locator, Page } from "@playwright/test";
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

/**
 * A Découvrir card, by the package's display name: the innermost block holding
 * both its title and its add button (cards carry no role of their own).
 */
function catalogueCard(page: Page, displayName: string): Locator {
  return page
    .locator("div")
    .filter({ has: page.getByRole("button", { name: displayName, exact: true }) })
    .filter({ has: page.getByRole("button", { name: /^Ajouter à / }) })
    .last();
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
    api_key: "sk-ant-e2e",
  });
  expect(credential.status(), await credential.text()).toBe(201);
  const model = await apiClient.post("/models", {
    modelId: "claude-sonnet-4-5-20250929",
    credentialId: (await credential.json()).id,
  });
  expect(model.status(), await model.text()).toBe(201);

  // A GUEST: invited for exactly one thing, with no space assignment. Named
  // distinctly on purpose — the `share-target` picker below is ONE Radix
  // listbox over people AND spaces, driven by typeahead on the option's FIRST
  // word, and every other seeded user in this organization is an "E2E User …",
  // so a shared first word would commit whichever option the list happened to
  // highlight.
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
    await adminPage.getByRole("button", { name: "Actions", exact: true }).click();
    await adminPage.getByRole("menuitem", { name: /Partager|Share/ }).click();
    // The option's label is the member's `displayName`, which the sign-up hook
    // seeds from `user.name` (`profiles.displayName = user.name || user.email`)
    // — so it is the NAME on the wire here, not the address.
    await selectOption(adminPage, "share-target", guest.name);
    const shared = adminPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/shares") === true,
    );
    await adminPage.getByRole("button", { name: /^(Partager|Share)$/ }).click();
    expect((await shared).status()).toBe(200);
  } finally {
    await adminPage.context().close();
  }

  // ── The guest finds it and switches it on in their own space ──
  // It is READABLE now, and still not runnable: a placement nobody activated
  // runs nowhere. No `?version=` selector anywhere in this test but the
  // negative control below — an omitted selector is what resolves the latest
  // published version.
  expect((await guestClient.get(`/packages/agents/${scope}/${name}`)).status()).toBe(200);
  expect((await guestClient.post(`/agents/${scope}/${name}/run`, {})).status()).toBe(404);

  const guestPage = await (
    await createAuthedContext(browser, guest, orgId, guestSpaceId)
  ).newPage();
  try {
    // The organization library answers every member, graded by what they read.
    expect((await guestClient.get("/library")).status()).toBe(200);

    // The index lists what RUNS here, and a placement switched off runs nowhere
    // — so it is not on it. The absence is read after the list response lands,
    // not against a loading page.
    const indexRead = guestPage.waitForResponse(
      (response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname === "/api/agents",
    );
    await guestPage.goto("/agents");
    expect((await indexRead).status()).toBe(200);
    await expect(guestPage.getByText(`Test Agent ${name}`, { exact: true })).toHaveCount(0);

    // THE door is `POST /api/spaces/{spaceId}/packages`, the same route the
    // catalogue's switches call for a team space. A guest holds no
    // `agents:configure` anywhere; owning the space is the authorization (RBAC
    // spec §3.6). The door is driven over the API here; the guest test further
    // down switches the same kind of placement on from the catalogue.
    const activated = await guestClient.post(`/spaces/${guestSpaceId}/packages`, {
      packageId: `${scope}/${name}`,
    });
    expect(activated.status(), await activated.text()).toBe(201);

    // Off again, and back on. Deactivating keeps the placement and its
    // settings; the status reports the STATE CHANGE, so switching it back on is
    // another 201 and only an already-on package answers 200.
    const deactivated = await guestClient.delete(
      `/spaces/${guestSpaceId}/packages/${scope}/${name}`,
    );
    expect(deactivated.status(), await deactivated.text()).toBe(204);
    expect((await guestClient.post(`/agents/${scope}/${name}/run`, {})).status()).toBe(404);

    const reactivated = await guestClient.post(`/spaces/${guestSpaceId}/packages`, {
      packageId: `${scope}/${name}`,
    });
    expect(reactivated.status(), await reactivated.text()).toBe(201);
  } finally {
    await guestPage.context().close();
  }

  // Active in the guest's own space, and the run route no longer refuses them:
  // the execution gate is the activation, which is now theirs.
  const placed = await guestClient.get(`/spaces/${guestSpaceId}/packages`);
  expect(placed.status()).toBe(200);
  expect(
    ((await placed.json()).data as { packageId: string }[]).map((row) => row.packageId),
  ).toContain(`${scope}/${name}`);
  const firstRun = await guestClient.post(`/agents/${scope}/${name}/run`, {});
  expect(firstRun.status(), await firstRun.text()).toBe(201);
  expect((await firstRun.json()).version_ref).toBe("0.1.0");

  // The negative control the pin concealed: the draft is the author's working
  // copy. Activating the package in your space does not make it yours to run —
  // this exact call answered 404 before the share, and the moment it stopped
  // doing so it would have executed the admin's uncommitted bytes.
  const guestDraft = await guestClient.post(`/agents/${scope}/${name}/run?version=draft`, {});
  expect(guestDraft.status(), await guestDraft.text()).toBe(403);
  expect((await guestDraft.json()).code).toBe("draft_not_writable");

  // The author ships a fix — a changed prompt, published as the next version
  // (the same content under a new number is `409 no_changes`). Nobody accepts
  // anything again, nobody re-pins: the next run the guest starts carries it.
  const draft = await apiClient.get(`/packages/agents/${scope}/${name}`);
  expect(draft.status(), await draft.text()).toBe(200);
  const fixed = await apiClient.patch(
    `/packages/agents/${scope}/${name}`,
    { content: "Fixed prompt." },
    { "If-Match": draft.headers()["etag"]! },
  );
  expect(fixed.status(), await fixed.text()).toBe(200);
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

/**
 * A placement shared OFF is switched on from the catalogue, and the index follows.
 *
 * The author cannot activate in another member's personal space, so the share
 * lands there switched off: placed, readable, not running. The recipient never
 * meets it on the index — that page is the active set — so the catalogue is
 * where they find it (its card says who shared it) and where they switch it
 * on. What this drives from the browser, and no route test can, is the cache
 * seam behind that split: the index visited BEFORE the activation must show the
 * agent AFTER it, in the same SPA session, because the activation invalidates
 * the list it was absent from.
 */
test("a placement shared OFF is switched on from the catalogue and lands on an already visited index", async ({
  request,
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `shared-off-${Date.now().toString(36)}`;
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
    target: { kind: "user", userId: member.userId },
  });
  expect(shared.status(), await shared.text()).toBe(200);

  // Landed OFF: a row in the member's space, switched off.
  const memberClient = createApiClient(request, {
    cookie: member.cookie,
    orgId,
    spaceId: personalId,
  });
  const placed = await memberClient.get(`/spaces/${personalId}/packages`);
  expect(placed.status()).toBe(200);
  expect(
    ((await placed.json()).data as { packageId: string; enabled?: boolean }[]).find(
      (row) => row.packageId === `${scope}/${name}`,
    )?.enabled,
  ).toBe(false);

  const page = await (await createAuthedContext(browser, member, orgId, personalId)).newPage();
  try {
    // The index is visited FIRST and is empty of it: a switched-off placement
    // runs nowhere, so nothing on this page shows it.
    const indexRead = page.waitForResponse(
      (response) =>
        response.request().method() === "GET" && new URL(response.url()).pathname === "/api/agents",
    );
    await page.goto("/agents");
    expect((await indexRead).status()).toBe(200);
    await expect(page.getByText(`Test Agent ${name}`, { exact: true })).toHaveCount(0);

    // Stay in one SPA session from here: a reload would discard the cache
    // under test. The sidebar opens the catalogue, whose card names the sharer
    // for THIS space and adds it here in one click.
    await page.getByRole("link", { name: /^Catalogue/ }).click();
    const card = catalogueCard(page, `Test Agent ${name}`);
    await expect(card.getByText(`Partagé par ${browserCtx.auth.name}`)).toBeVisible();
    const activated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/spaces/${personalId}/packages`),
    );
    await card.getByRole("button", { name: "Ajouter à Mon espace", exact: true }).click();
    // 201: this call is what switched the existing placement on.
    expect((await activated).status()).toBe(201);

    // And now it is on the index that was visited before any of this — without
    // a reload, because the activation invalidates that very list.
    await page.getByRole("button", { name: "Fermer", exact: true }).click();
    await page.locator('a[href="/agents"]').first().click();
    await expect(page.getByText(`Test Agent ${name}`, { exact: true }).first()).toBeVisible();
  } finally {
    await page.context().close();
  }
});

// A GUEST in their own personal space holds no `<type>:activate` grant there, yet the server lets
// the owner of a personal space activate (RBAC spec §3.6, and the API test above). The catalogue
// (`catalogueKinds`) reads the same verdict as every activation control, so its entry is there and
// the placement a guest is sent switched off can be switched on. Members hold the grant (the test
// before).
test("a guest finds a placement shared OFF in the catalogue and switches it on", async ({
  request,
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `guest-shared-${Date.now().toString(36)}`;
  await createAgent(apiClient, scope, name);
  const guest = await registerUser(request);
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
  const shared = await apiClient.post(`/packages/${scope}/${name}/shares`, {
    target: { kind: "user", userId: guest.userId },
  });
  expect(shared.status(), await shared.text()).toBe(200);

  const page = await (await createAuthedContext(browser, guest, orgId, guestSpaceId)).newPage();
  try {
    await page.goto("/agents");
    await page.getByRole("link", { name: /^Catalogue/ }).click({ timeout: 5_000 });
    const card = catalogueCard(page, `Test Agent ${name}`);
    await expect(card.getByText(/^Partagé par /)).toBeVisible();
    const activated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/spaces/${guestSpaceId}/packages`),
    );
    await card.getByRole("button", { name: "Ajouter à Mon espace", exact: true }).click();
    expect((await activated).status()).toBe(201);

    // Off again from the space's switch, and back on. Deactivating keeps the placement: the
    // switch stays, unchecked, and switching it back on is another 201.
    await page.getByRole("tab", { name: "Par espace", exact: true }).click();
    const toggle = page
      .getByRole("row")
      .filter({ hasText: `Test Agent ${name}` })
      .getByRole("switch", { name: `Activer Test Agent ${name} dans Mon espace`, exact: true });
    await expect(toggle).toBeChecked();
    const deactivated = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes(`/packages/${scope}/${name}`),
    );
    await toggle.click();
    expect((await deactivated).status()).toBe(204);
    await expect(toggle).not.toBeChecked();

    const reactivated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/spaces/${guestSpaceId}/packages`),
    );
    await toggle.click();
    expect((await reactivated).status()).toBe(201);
    await expect(toggle).toBeChecked();
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
    await page.getByRole("button", { name: "Actions", exact: true }).click();
    await page.getByRole("menuitem", { name: /Partager|Share/ }).click();
    await selectOption(page, "share-target", member.name);

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

  // The recipient really has the offer, and switching it on in their own space
  // needs no grant — owning the space is the authorization.
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

test("a non-admin builder switches a team placement off and on from the space package view", async ({
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
    space_assignments: [{ spaceId, preset_role: "builder" }],
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
        target: { kind: "space", spaceId },
      })
    ).status(),
  ).toBe(200);
  const page = await (await createAuthedContext(browser, member, orgId, spaceId)).newPage();
  try {
    await page.goto("/catalogue/placed/agent");
    // One row, one switch: a placement shared here sits in the same list as the
    // packages authored here. The author holds the activation grant in this
    // space, so the share landed ON.
    const displayName = `Test Agent ${name}`;
    const row = page.getByRole("row").filter({ hasText: displayName });
    const toggle = row.getByRole("switch", {
      name: `Activer ${displayName} dans Default`,
      exact: true,
    });
    await expect(toggle).toBeChecked();
    const deactivated = page.waitForResponse(
      (response) =>
        response.request().method() === "DELETE" &&
        response.url().includes(`/spaces/${spaceId}/packages/${scope}/${name}`),
    );
    await toggle.click();
    expect((await deactivated).status()).toBe(204);
    // The row survives the switch — deactivating is not a removal.
    await expect(toggle).not.toBeChecked();
    await expect(row).toBeVisible();
    await expect(row.getByText("Inactif", { exact: true })).toBeVisible();
    const activated = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/spaces/${spaceId}/packages`),
    );
    await toggle.click();
    expect((await activated).status()).toBe(201);
    await expect(toggle).toBeChecked();
  } finally {
    await page.context().close();
  }
});
