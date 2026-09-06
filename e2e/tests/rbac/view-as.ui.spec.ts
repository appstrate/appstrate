// SPDX-License-Identifier: Apache-2.0

/**
 * "View as role" in the browser — the SPA half of the preview.
 *
 * The preview is entered here by seeding the persisted persona, the way the
 * entry dialog will (phase 3). What these tests hold is everything downstream
 * of that: the persona reaches the server on every request, the answer it
 * produces is the one the UI renders, the banner says who you are, and the one
 * exit puts the real authority back.
 *
 * The Run button is the discriminator: it is gated on `agents:run`, which a
 * `viewer` in the space does not hold and the previewing owner does.
 */

import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import type { Page } from "@playwright/test";
import { createAgent, createSpace } from "../../helpers/seed.ts";

/** The shape `stores/view-as-store.ts` persists, under its own key. */
interface Persona {
  orgId: string;
  orgRole: "member" | "guest";
  space: { spaceId: string; role: string; roleLabel: string; spaceName: string } | null;
}

async function seedPersona(page: Page, persona: Persona) {
  await page.addInitScript(
    (value) => localStorage.setItem("appstrate_view_as", value),
    JSON.stringify(persona),
  );
}

const banner = (page: Page) => page.getByTestId("view-as-banner");
/** The detail header renders a wide and a compact variant of the same action. */
const runButton = (page: Page) => page.getByRole("button", { name: /^(Lancer|Run)$/ });

test.describe("View as role", () => {
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

      await expect(page.getByText(/Prévisualisation arrêtée|Preview stopped/)).toBeVisible();
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
