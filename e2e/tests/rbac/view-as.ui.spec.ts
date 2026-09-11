// SPDX-License-Identifier: Apache-2.0

/**
 * "View as role" in the browser.
 *
 * Two halves. The first three tests take the REAL path — the dialog, from each
 * of its two triggers — because that is the only place the portalled
 * `<Select>`s and radio options can be exercised at all (the no-DOM web harness
 * renders the whole dialog as an empty string). The rest seed the persisted
 * persona directly, which is how a RELOAD and a persona whose space or stream
 * the server refuses can be reached without re-driving the dialog each time.
 *
 * The Run button is the discriminator throughout: it is gated on `agents:run`,
 * which a `viewer` in the space does not hold and the previewing owner does.
 */

import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import type { Page } from "@playwright/test";
import type { ViewAsOrgRole } from "@appstrate/core/permissions";

/** The key `apps/web/src/stores/view-as-store.ts` persists the persona under. */
const STORAGE_KEY = "appstrate_view_as";
import { createAgent, createSpace } from "../../helpers/seed.ts";
import { Sidebar } from "../../pages/sidebar.ts";

/** The shape `stores/view-as-store.ts` persists, under its own key. */
interface Persona {
  orgId: string;
  orgRole: ViewAsOrgRole;
  space: { spaceId: string; role: string; roleLabel: string; spaceName: string } | null;
}

async function seedPersona(page: Page, persona: Persona) {
  await page.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    STORAGE_KEY,
    JSON.stringify(persona),
  ] as const);
}

const banner = (page: Page) => page.getByTestId("view-as-banner");
/** The detail header renders a wide and a compact variant of the same action. */
const runButton = (page: Page) => page.getByRole("button", { name: /^(Lancer|Run)$/ });

test.describe("View as role", () => {
  test("is entered from the Roles page and left from the banner @critical", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `view-as-entry-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);
    const agentUrl = `/agents/${scope}/${agentName}`;

    // Start in ANOTHER open space: entering a space-scoped preview has to land
    // where the persona's role applies, not leave the user where they were.
    const elsewhere = await createSpace(apiClient, `elsewhere-${Date.now()}`);
    await page.goto("/org-settings/roles");
    await new Sidebar(page).switchSpace(elsewhere.name);

    await page.getByTestId("view-as-button").click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    // Only the two roles a preview can be: previewing owner/admin would remove
    // nothing, and the server refuses it.
    await expect(dialog.getByRole("radio", { name: /Utilisateur standard/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /^Invité/ })).toBeVisible();
    await expect(dialog.getByRole("radio", { name: /Administrateur/ })).toHaveCount(0);
    // Space defaults to the one the user is in; the role is chosen here.
    await expect(dialog.locator("#view-as-space")).toContainText(elsewhere.name);
    await dialog.locator("#view-as-space").click();
    await page.getByRole("option", { name: "Default", exact: true }).click();
    await dialog.locator("#view-as-space-role").click();
    await page.getByRole("option", { name: /^(Lecteur|Viewer)$/ }).click();
    await expect(dialog.locator("#view-as-space-role")).toContainText("Lecteur");

    await dialog.getByTestId("view-as-submit").click();

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText("Lecteur");
    // Landed in the persona's space.
    await expect
      .poll(() => page.evaluate(() => localStorage.getItem("appstrate_current_space")))
      .toBe(browserCtx.org.defaultSpaceId);
    await expect(banner(page)).not.toContainText(/espace ouvert|open space/);

    await page.goto(agentUrl);
    await expect(runButton(page)).toHaveCount(0);

    // Elsewhere the persona is an implicit member of an open space with its
    // default role, and the banner says so for the space being looked at.
    await new Sidebar(page).switchSpace(elsewhere.name);
    await expect(banner(page)).toContainText(elsewhere.name);
    await expect(banner(page)).toContainText(/Opérateur|Operator/);
    await expect(banner(page)).toContainText(/espace ouvert|open space/);

    await banner(page)
      .getByRole("button", { name: /^(Quitter|Exit)$/ })
      .click();
    await expect(banner(page)).toHaveCount(0);
    await page.goto(agentUrl);
    await expect(runButton(page).first()).toBeVisible();
  });

  test("waits for the role catalog instead of calling it empty", async ({ authedPage: page }) => {
    // The catalog is what says which roles are grantable HERE; treating "not
    // answered yet" as "none" told every cold open that no role was previewable.
    let release = () => {};
    const stalled = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route("**/api/spaces/*/roles*", async (route) => {
      await stalled;
      await route.continue();
    });

    await page.goto("/org-settings/space/members");
    await page.getByTestId("view-as-space-button").click();
    const dialog = page.getByRole("dialog");

    await expect(dialog.getByRole("status")).toBeVisible();
    await expect(dialog).not.toContainText("Aucun rôle prévisualisable");
    await expect(dialog.getByTestId("view-as-submit")).toBeDisabled();

    release();
    await expect(dialog.locator("#view-as-space-role")).toBeVisible();
    await expect(dialog.getByRole("status")).toHaveCount(0);
  });

  test("is entered from Space members, as a guest with no space", async ({ authedPage: page }) => {
    await page.goto("/org-settings/space/members");
    await page.getByTestId("view-as-space-button").click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("radio", { name: /^Invité/ }).click();
    // A guest belongs to no space unless assigned; drop the space half so the
    // persona is the org role alone.
    await dialog.locator("#view-as-space").click();
    await page.getByRole("option", { name: "Aucun espace" }).click();
    // The SPA's OWN next read of the spaces list, not a hand-built request: what
    // is under test is that the persona rides the app's transport, is answered
    // as the persona (the marker), and empties the list a guest with no
    // assignment sees. Captured through `route` rather than `waitForResponse`
    // because dropping every space navigates the app away, and a response body
    // cannot be read after that.
    let previewed: { header?: string; marker?: string; status: number; body: string } | undefined;
    await page.route(
      (url) => url.pathname === "/api/spaces",
      async (route) => {
        const response = await route.fetch();
        const header = route.request().headers()["x-view-as"];
        if (!previewed && header) {
          previewed = {
            header,
            marker: response.headers()["x-view-as-active"],
            status: response.status(),
            body: await response.text(),
          };
        }
        await route.fulfill({ response });
      },
    );
    await dialog.getByTestId("view-as-submit").click();

    await expect.poll(() => previewed?.header).toBe("org_role=guest");
    expect(previewed?.status).toBe(200);
    expect(previewed?.marker).toBe("1");
    expect((JSON.parse(previewed?.body ?? "{}") as { data: unknown[] }).data).toEqual([]);

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText("Invité");

    await banner(page)
      .getByRole("button", { name: /^(Quitter|Exit)$/ })
      .click();
    await expect(banner(page)).toHaveCount(0);
  });

  test("previews a viewer, then gives the owner their authority back @critical", async ({
    authedPage: page,
    apiClient,
    browserCtx,
  }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `view-as-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);
    const agentUrl = `/agents/${scope}/${agentName}`;

    // Control: the owner can run it.
    await page.goto(agentUrl);
    await expect(runButton(page).first()).toBeVisible();

    await seedPersona(page, {
      orgId: browserCtx.org.orgId,
      orgRole: "member",
      space: {
        spaceId: browserCtx.org.defaultSpaceId,
        role: "preset:viewer",
        roleLabel: "Lecteur",
        spaceName: "Default",
      },
    });

    // Proof the persona travelled: the server marks every response it answered
    // under one, and only those.
    const previewedSpaces = page.waitForResponse(
      (r) => r.url().includes("/api/spaces") && r.request().method() === "GET",
    );
    await page.goto(agentUrl);
    expect((await previewedSpaces).headers()["x-view-as-active"]).toBe("1");

    await expect(banner(page)).toBeVisible();
    await expect(banner(page)).toContainText(/Utilisateur standard|Standard user/);
    await expect(banner(page)).toContainText("Lecteur");
    await expect(banner(page)).toContainText("Default");
    await expect(runButton(page)).toHaveCount(0);

    await banner(page)
      .getByRole("button", { name: /^(Quitter|Exit)$/ })
      .click();

    await expect(banner(page)).toHaveCount(0);
    await expect(runButton(page).first()).toBeVisible();
  });

  test("survives a reload", async ({ authedPage: page, apiClient, browserCtx }) => {
    const scope = `@${browserCtx.org.orgSlug}`;
    const agentName = `view-as-reload-${Date.now()}`;
    await createAgent(apiClient, scope, agentName);

    await seedPersona(page, {
      orgId: browserCtx.org.orgId,
      orgRole: "member",
      space: {
        spaceId: browserCtx.org.defaultSpaceId,
        role: "preset:viewer",
        roleLabel: "Lecteur",
        spaceName: "Default",
      },
    });
    await page.goto(`/agents/${scope}/${agentName}`);
    await expect(banner(page)).toBeVisible();

    await page.reload();
    await expect(banner(page)).toBeVisible();
    await expect(runButton(page)).toHaveCount(0);
  });

  test("ends itself when the realtime stream refuses the persona", async ({
    authedPage: page,
    browserCtx,
  }) => {
    // The live stream is the one reader that RETRIES, so on an idle tab it is
    // the only thing that can notice a refusal and end the preview — without
    // this the banner keeps claiming one while the stream reconnects forever.
    // Everything else about this persona is valid.
    await page.route("**/api/realtime/runs?*", (route) =>
      route.fulfill({
        status: 403,
        contentType: "application/problem+json",
        body: JSON.stringify({ code: "view_as_forbidden", detail: "refused on the stream" }),
      }),
    );
    await seedPersona(page, {
      orgId: browserCtx.org.orgId,
      orgRole: "member",
      space: {
        spaceId: browserCtx.org.defaultSpaceId,
        role: "preset:viewer",
        roleLabel: "Lecteur",
        spaceName: "Default",
      },
    });

    await page.goto("/agents");
    await expect(page.getByText(/Prévisualisation indisponible|Preview unavailable/)).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
  });

  test("ends itself, with a reason, when the previewed space is gone", async ({
    browser,
    browserCtx,
    orgOnlyClient,
  }) => {
    const doomed = await createSpace(orgOnlyClient, `Doomed ${Date.now()}`);
    expect((await orgOnlyClient.delete(`/spaces/${doomed.id}`)).status()).toBe(204);

    // The default space stays selected — only the PERSONA names the dead one,
    // so what fails is the preview, not the page.
    const context = await createAuthedContext(
      browser,
      browserCtx.auth,
      browserCtx.org.orgId,
      browserCtx.org.defaultSpaceId,
    );
    const page = await context.newPage();
    try {
      await seedPersona(page, {
        orgId: browserCtx.org.orgId,
        orgRole: "member",
        space: {
          spaceId: doomed.id,
          role: "preset:viewer",
          roleLabel: "Lecteur",
          spaceName: doomed.name,
        },
      });
      await page.goto("/agents");

      await expect(
        page.getByText(/Prévisualisation indisponible|Preview unavailable/),
      ).toBeVisible();
      await expect(banner(page)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("hides the organization invite action under a member persona", async ({
    authedPage: page,
    browserCtx,
  }) => {
    await page.goto("/org-settings/members");
    await expect(page.getByTestId("invite-org-user-button")).toBeVisible();

    await seedPersona(page, {
      orgId: browserCtx.org.orgId,
      orgRole: "member",
      space: null,
    });
    await page.goto("/org-settings/members");

    await expect(banner(page)).toBeVisible();
    await expect(page.getByTestId("invite-org-user-button")).toHaveCount(0);
  });
});
