// SPDX-License-Identifier: Apache-2.0

/**
 * Sharing a package with a guest, end to end (RBAC spec §6.10).
 *
 * What a route test cannot show: that the two halves of the flow actually meet
 * in the SPA. An administrator shares an agent from the package page's own
 * dialog, and the guest — an external identity with no reach into any space —
 * finds it under "Partagé avec moi" in their library and adds it to their own
 * space with one button. Only then does the platform let them launch it, and
 * the administrator still cannot see inside that space.
 *
 * The launch is asserted as an ACCESS transition (404 before, something else
 * after) rather than as a completed run: this environment configures no model
 * provider, so a green-path run is not available to it.
 */

import type { APIRequestContext } from "@playwright/test";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createAgent, registerUser, type AuthResult } from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";
import { selectOption } from "../../helpers/radix.ts";

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
  // the sharing authority (`agents:share`) is held. A share is installed
  // PINNED, so the package needs a published version before it can be accepted
  // at all: `POST /packages/agents` already mints the manifest's `0.1.0`
  // (`createVersionSafe`), so republishing it here would be a 409
  // `no_changes`, not a second version.
  await createAgent(apiClient, scope, name);

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
    headers: { Cookie: guest.cookie, Origin: "http://localhost:3000" },
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
  expect((await guestClient.get(`/packages/agents/${scope}/${name}`)).status()).toBe(200);
  expect((await guestClient.post(`/agents/${scope}/${name}/run?version=draft`, {})).status()).toBe(
    404,
  );

  const guestPage = await (
    await createAuthedContext(browser, guest, orgId, guestSpaceId)
  ).newPage();
  try {
    await guestPage.goto("/library");
    await expect(guestPage.getByText(/Partagé avec moi|Shared with me/)).toBeVisible();
    const accept = guestPage.waitForResponse(
      (response) =>
        response.request().method() === "POST" && response.url().includes("/shares/accept"),
    );
    await guestPage.getByRole("button", { name: /Ajouter à mon espace|Add to my space/ }).click();
    expect((await accept).status()).toBe(200);
  } finally {
    await guestPage.context().close();
  }

  // Installed in the guest's own space, and the run route no longer refuses
  // them: the execution gate is the installation, which is now theirs.
  const installed = await guestClient.get(`/spaces/${guestSpaceId}/packages`);
  expect(installed.status()).toBe(200);
  expect(
    ((await installed.json()).data as { packageId: string }[]).map((row) => row.packageId),
  ).toContain(`${scope}/${name}`);
  expect(
    (await guestClient.post(`/agents/${scope}/${name}/run?version=draft`, {})).status(),
  ).not.toBe(404);

  // ── And the admin sees nothing of what happens in there ──
  const adminSpaceProbe = await request.get(`/api/spaces/${guestSpaceId}`, {
    headers: { Cookie: browserCtx.auth.cookie, "X-Org-Id": orgId },
  });
  expect(adminSpaceProbe.status()).toBe(404);
  const adminRuns = await apiClient.get(`/agents/${scope}/${name}/runs`);
  expect(adminRuns.status()).toBe(200);
  expect((await adminRuns.json()).data ?? []).toHaveLength(0);
});
