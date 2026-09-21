// SPDX-License-Identifier: Apache-2.0

/**
 * Reading a definition is not running it (RBAC spec §6.10).
 *
 * An agent with nothing published has exactly one definition — the author's
 * working copy — and the draft belongs to whoever can WRITE the package. That
 * rule governs EXECUTION, not reading: the agent list shows the package to
 * everyone the home space lets read it, so its detail page must open for them
 * too. A 404 there would make the list promise a page that does not exist.
 *
 * What opens instead is the draft in a read projection, said out loud by a
 * banner, with "Lancer" greyed out and carrying its reason — because a launch
 * sends no selector and the server answers `404 no_published_version`. The
 * second half is the control: the author publishes, the same reader reloads,
 * and the button comes back to life without anyone touching a permission.
 *
 * The reader is an `operator` (`agents:read` + `agents:run`, no `agents:write`)
 * seen through `view_as`, the same persona mechanism `run-rerun.ui.spec.ts`
 * uses — it is the caller's authority the server reads, so a persona is enough
 * to reach the exact branch.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgent } from "../../helpers/seed.ts";

test("a never-published agent opens read-only for an operator, and becomes launchable once published", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `draft-only-${Date.now().toString(36)}`;

  // `POST /packages/agents` mints the manifest's `0.1.0` on creation, so the
  // never-published shape is made by deleting it again — the same state an
  // author reaches when that best-effort snapshot was skipped and they have
  // not published since.
  await createAgent(apiClient, scope, name);
  const dropped = await apiClient.delete(`/packages/agents/${scope}/${name}/versions/0.1.0`);
  expect(dropped.status(), await dropped.text()).toBe(204);

  // The org needs a model, or "Lancer" is disabled for a reason that has
  // nothing to do with versions and both halves of this test read the same.
  // Nothing here reaches the provider — no run is started.
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

  await page.addInitScript(
    (persona) => {
      localStorage.setItem("appstrate_view_as", JSON.stringify(persona));
    },
    {
      orgId: browserCtx.org.orgId,
      orgRole: "member",
      space: {
        spaceId: browserCtx.org.defaultSpaceId,
        role: "preset:operator",
        roleLabel: "Operator",
        spaceName: "Default",
      },
    },
  );

  // The list shows it — creating a package activates it at its home, and the
  // index is the active set — so the detail must answer, and answer 200. The
  // card is a clickable div, not an anchor, so its heading is what there is to
  // click; clicking it is what a reader does, and the promise it makes is
  // exactly what this test is about.
  await page.goto("/agents");
  const detailResponse = page.waitForResponse((response) =>
    response.url().includes(`/api/packages/agents/${scope}/${name}`),
  );
  await page.getByRole("heading", { name: `Test Agent ${name}`, exact: true }).click();
  expect((await detailResponse).status()).toBe(200);
  await expect(page).toHaveURL(new RegExp(`/agents/${scope}/${name}$`));

  // What the page says it is showing, and why the button is dead.
  await expect(page.getByText(/Aucune version publiée|No published version/).first()).toBeVisible();
  const run = page.getByRole("button", { name: /^(Lancer|Run)$/ }).first();
  await expect(run).toBeDisabled();

  // The author publishes. Nothing about the reader changes.
  const published = await apiClient.post(`/packages/agents/${scope}/${name}/versions`, {
    version: "0.2.0",
  });
  expect(published.status(), await published.text()).toBe(201);

  await page.reload();
  await expect(page.getByText(/Aucune version publiée|No published version/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^(Lancer|Run)$/ }).first()).toBeEnabled();
});
