// SPDX-License-Identifier: Apache-2.0

/**
 * The organization library as a MAP of placements, driven from the browser
 * (RBAC spec §6.8).
 *
 * `/library` renders the three axes the model has — home, share, activation —
 * and every one of them is actionable from the row. A single cell meaning "a
 * `space_packages` row exists here" can say none of it: it tells a home from a
 * share not at all, has nowhere to show a share, and gives one act two buttons.
 * So the four acts below have to work, on one screen:
 *
 *   - switching a package ON in a space it never reached shares it there and
 *     activates it in one click, and the chip under "Partagé avec" appears;
 *   - removing that chip revokes the share, and the switch falls with it,
 *     because a revocation takes the placement away;
 *   - switching a package OFF at home keeps the row and everything on it — the
 *     model chosen for that space is still there afterwards — a switch moves,
 *     the row does not;
 *   - moving the home moves the Home column and leaves the source space
 *     reading a package it no longer homes.
 *
 * What a route test cannot show is that these four sit on one screen and that
 * the caches they invalidate agree afterwards.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgent, createSpace } from "../../helpers/seed.ts";

/** The catalog row for one package, whatever tab it is under. */
function rowFor(page: Page, displayName: string) {
  return page.getByRole("row").filter({ hasText: displayName });
}

/**
 * The activation switch for one space, by its column position. The header's
 * last row carries one cell per space in the same order as the body row's
 * trailing cells, so the index of the space name is the index of the switch.
 */
async function spaceColumn(page: Page, spaceName: string): Promise<number> {
  const names = await page.locator("thead tr").last().locator("th").allTextContents();
  const index = names.findIndex((text) => text.includes(spaceName));
  expect(index, `no column named ${spaceName} in ${names.join(" | ")}`).toBeGreaterThanOrEqual(0);
  return index;
}

test("an admin places, revokes, deactivates and moves a package from the catalog", async ({
  authedPage: page,
  apiClient,
  browserCtx,
  orgOnlyClient,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `catalog-${Date.now().toString(36)}`;
  const displayName = `Test Agent ${name}`;
  // The agent is authored in the organization's default space — its home, and
  // the space whose `agents:share` the admin holds.
  await createAgent(apiClient, scope, name);
  const target = await createSpace(orgOnlyClient, `Target ${Date.now().toString(36)}`);
  // The default space's name is the catalog's column header for it; read it
  // rather than assume the platform's default string.
  const homeSpace = await orgOnlyClient.get(`/spaces/${browserCtx.org.defaultSpaceId}`);
  expect(homeSpace.status()).toBe(200);
  const homeSpaceName = (await homeSpace.json()).name as string;

  const packagesIn = async (spaceId: string) => {
    const res = await orgOnlyClient.get(`/spaces/${spaceId}/packages`);
    expect(res.status()).toBe(200);
    return (await res.json()).data as Array<{
      packageId: string;
      enabled?: boolean;
      modelId?: string | null;
    }>;
  };

  await page.goto("/library");
  const row = rowFor(page, displayName);
  await expect(row).toBeVisible();
  const targetColumn = await spaceColumn(page, target.name);
  const homeColumn = await spaceColumn(page, homeSpaceName);

  // ── One click places it in a space it never reached ──
  const activated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/spaces/${target.id}/packages`),
  );
  await row.getByRole("checkbox").nth(targetColumn).click();
  expect((await activated).status()).toBe(201);
  // The share it minted is a fact on the wire, not only a checkbox: the chip
  // under "Partagé avec" names the destination.
  await expect(row.getByText(target.name, { exact: false }).first()).toBeVisible();
  const shares = await apiClient.get(`/packages/${scope}/${name}/shares`);
  expect(shares.status()).toBe(200);
  expect(
    ((await shares.json()).data as Array<{ target: { spaceId?: string } }>).map(
      (entry) => entry.target.spaceId,
    ),
  ).toContain(target.id);
  expect((await packagesIn(target.id)).map((p) => p.packageId)).toContain(`${scope}/${name}`);

  // ── Revoking the share takes the placement away with it ──
  const revoked = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" && response.url().includes(`/shares/${target.id}`),
  );
  await row
    .getByRole("button", { name: /Retirer ce partage|Revoke this share/ })
    .first()
    .click();
  expect((await revoked).status()).toBe(204);
  await expect(row.getByRole("checkbox").nth(targetColumn)).not.toBeChecked();
  expect((await packagesIn(target.id)).map((p) => p.packageId)).not.toContain(`${scope}/${name}`);

  // ── Deactivating at home keeps the row and its settings ──
  // A model chosen for the home space is what proves it: switch the package
  // off, switch it back on, and the choice is still there. Taking the
  // placement away would have taken the choice with it.
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
  const modelId = (await model.json()).id as string;
  const configured = await apiClient.patch(
    `/spaces/${browserCtx.org.defaultSpaceId}/packages/${scope}/${name}`,
    { modelId },
  );
  expect(configured.status(), await configured.text()).toBe(200);

  const deactivated = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      response.url().includes(`/spaces/${browserCtx.org.defaultSpaceId}/packages/${scope}/${name}`),
  );
  await row.getByRole("checkbox").nth(homeColumn).click();
  expect((await deactivated).status()).toBe(204);
  const offRow = (await packagesIn(browserCtx.org.defaultSpaceId)).find(
    (p) => p.packageId === `${scope}/${name}`,
  );
  expect(offRow, "the placement survives its own deactivation").toBeDefined();
  expect(offRow?.enabled).toBe(false);
  expect(offRow?.modelId).toBe(modelId);

  const reactivated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/spaces/${browserCtx.org.defaultSpaceId}/packages`),
  );
  await row.getByRole("checkbox").nth(homeColumn).click();
  // 201 says THIS call turned it on — the status reports the state change, not
  // whether a row was created; the row never went away.
  expect((await reactivated).status()).toBe(201);
  // And the settings the row carried came back with it, which is what makes
  // deactivation a switch and not a removal.
  expect(
    (await packagesIn(browserCtx.org.defaultSpaceId)).find(
      (p) => p.packageId === `${scope}/${name}`,
    )?.modelId,
  ).toBe(modelId);
  // Asking again changes nothing, and says so: 200, no state change.
  const alreadyOn = await apiClient.post(`/spaces/${browserCtx.org.defaultSpaceId}/packages`, {
    packageId: `${scope}/${name}`,
  });
  expect(alreadyOn.status(), await alreadyOn.text()).toBe(200);

  // ── Moving the home activates the destination and leaves a share behind ──
  const moved = await apiClient.put(`/packages/${scope}/${name}/home`, {
    home_space_id: target.id,
  });
  expect(moved.status(), await moved.text()).toBe(200);
  await page.reload();
  const movedRow = rowFor(page, displayName);
  // Home is now the destination, and it runs there without anybody activating
  // it: creating a package activates it at its home, and so does moving one.
  await expect(movedRow.getByText(target.name, { exact: false }).first()).toBeVisible();
  expect(
    (await packagesIn(target.id)).find((p) => p.packageId === `${scope}/${name}`)?.enabled,
  ).toBe(true);
  // And the space it came from keeps reading it, through the share the move
  // minted — with its own row, still carrying the model chosen back then.
  expect(
    (await packagesIn(browserCtx.org.defaultSpaceId)).find(
      (p) => p.packageId === `${scope}/${name}`,
    )?.modelId,
  ).toBe(modelId);
});

/**
 * The page that repairs a switched-off agent is the page that must open — and
 * the two lists that must disagree about it.
 *
 * Deactivating is reversible and ordinary, so it has to be legible in exactly
 * one place. The INDEX answers "what can I run here", so a switched-off agent
 * leaves it entirely: no greyed card, no badge, nothing to misread. The space
 * LIBRARY answers "what is placed here, and in what state", so the same agent
 * is still a row there, marked off, with its switch (RBAC spec §6.8/§6.9).
 *
 * The detail page has to stay reachable through all of it: every READ and
 * CONFIGURE route answers 200 for an agent placed here and switched off (only
 * run, rerun, schedule creation and bundle refuse it with
 * `404 agent_not_active_in_space`), and the readiness read reports the blockage
 * as an error inside a 200 rather than 404-ing the panel meant to show it. That
 * matters because the SPA's client THROWS on any non-2xx: one 404 on
 * `GET …/model` or `GET …/connection-readiness` and the detail page loses the
 * model editor and the connections panel — on exactly the screen that carries
 * the switch back on.
 */
test("a switched-off agent leaves the index, stays in the library, and is switched back on from its page", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `offpage-${Date.now().toString(36)}`;
  await createAgent(apiClient, scope, name);

  // A model has to EXIST for the model editor to render at all, so the agent
  // being off is the only thing left that could hide it.
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

  // ── Switched off, through the one door that does it ──
  const off = await apiClient.delete(
    `/spaces/${browserCtx.org.defaultSpaceId}/packages/${scope}/${name}`,
  );
  expect(off.status(), await off.text()).toBe(204);

  // ── Still in the library, off the index ──
  // Two questions, two pages. The library is the placement map, so the row is
  // there, marked off, with its switch; the index is the ACTIVE set, so the
  // card is gone — not greyed, gone.
  await page.goto("/space/packages");
  const libraryRow = page.getByRole("row").filter({ hasText: `Test Agent ${name}` });
  await expect(libraryRow).toBeVisible();
  await expect(libraryRow.getByText(/^(Désactivé|Inactive)$/)).toBeVisible();
  await expect(libraryRow.getByRole("checkbox")).not.toBeChecked();

  // Waited on the LIST response, not on a heading: an absence asserted while
  // the page is still loading passes for the wrong reason.
  const indexRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" && new URL(response.url()).pathname === "/api/agents",
  );
  await page.goto("/agents");
  expect((await indexRead).status()).toBe(200);
  await expect(page.getByText(`Test Agent ${name}`, { exact: true })).toHaveCount(0);

  // ── The detail page opens, and its two reads answer 200 ──
  // One page, one source: the agent's own detail carries `active`, so the page
  // must not also project the space library to learn the same fact. Recorded
  // across the whole load, and asserted before anything is clicked — which is
  // why the library page is visited ABOVE the index and not here: a full
  // navigation sits between it and this listener, so no refetch it left in
  // flight can be counted against the page under test.
  const libraryReads: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/spaces\/[^/]+\/library/.test(request.url())) libraryReads.push(request.url());
  });
  const modelRead = page.waitForResponse(
    (response) =>
      response.request().method() === "GET" &&
      response.url().includes(`/agents/${scope}/${name}/model`),
  );
  const readinessRead = page.waitForResponse((response) =>
    response.url().includes(`/agents/${scope}/${name}/connection-readiness`),
  );
  await page.goto(`/agents/${scope}/${name}`);
  expect((await modelRead).status(), "GET …/model on a switched-off agent").toBe(200);
  expect((await readinessRead).status(), "GET …/connection-readiness on a switched-off agent").toBe(
    200,
  );

  // One line of state, and the cure beside it — nothing to justify, since the
  // reader got here from the library or from a link they kept.
  const banner = page.getByText(/Désactivé dans cet espace|Switched off in this space/);
  await expect(banner).toBeVisible();
  expect(libraryReads, "the agent page answers activation from its own detail").toEqual([]);

  // ── Configured while off: choosing a model is a read-write on the placement,
  //    not a run, so the route takes it ──
  await page.getByRole("tab", { name: "Paramètres par défaut", exact: true }).click();
  const modelWrite = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/agents/${scope}/${name}/model`),
  );
  await page
    .getByRole("button", { name: /Enregistrer les réglages du modèle|Save model settings/ })
    .click();
  expect((await modelWrite).status(), "PATCH …/model on a switched-off agent").toBe(200);

  // ── Switched back on from the banner itself ──
  const activated = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith(`/spaces/${browserCtx.org.defaultSpaceId}/packages`),
  );
  await page.getByRole("button", { name: /^(Activer|Activate)$/ }).click();
  // 201: this call is what turned it on.
  expect((await activated).status()).toBe(201);
  await expect(banner).toHaveCount(0);

  // And the index takes it back, on the same rule that dropped it.
  await page.goto("/agents");
  await expect(page.getByText(`Test Agent ${name}`, { exact: true }).first()).toBeVisible();
});
