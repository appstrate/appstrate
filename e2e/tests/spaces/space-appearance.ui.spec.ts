// SPDX-License-Identifier: Apache-2.0

/**
 * A space's appearance, end to end: a team space takes a Lucide icon and a
 * colour in its settings and wears them in the switcher; a personal space has
 * no appearance of its own — the editor is not drawn and the route refuses it.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { Sidebar } from "../../pages/sidebar.ts";

test("a team space's icon and colour, set in its settings, show in the switcher", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const spaceId = browserCtx.org.defaultSpaceId;
  const stored = async () => {
    const res = await orgOnlyClient.get(`/spaces/${spaceId}`);
    expect(res.status()).toBe(200);
    const space = await res.json();
    return { icon: space.icon as string | null, color: space.color as string | null };
  };
  const settings = page.getByRole("dialog", { name: "Paramètres", exact: true });

  await page.goto("/workspace-settings/general");
  // The Lucide trigger is a combobox named « Icône » and its current value (the picker draws no heading).
  const iconPicker = settings.getByRole("combobox", { name: /^Icône /u });
  await expect(iconPicker).toHaveText("Choisir une icône");
  await iconPicker.click();
  await page.getByPlaceholder("Rechercher une icône Lucide…", { exact: true }).fill("rocket");
  await page.getByRole("option", { name: "Rocket", exact: true }).click();
  await expect.poll(async () => (await stored()).icon).toBe("lucide:rocket");
  await expect(iconPicker).toHaveText("Rocket");
  await settings.getByTitle("Émeraude", { exact: true }).click();
  await expect.poll(stored).toEqual({ icon: "lucide:rocket", color: "emerald" });

  await page.goto("/");
  const sidebar = new Sidebar(page);
  await sidebar.openSwitcher();
  const tile = page.getByTestId(`space-item-${spaceId}`).locator('[class*="@container"]');
  await expect(tile).toHaveClass(/text-identity-emerald/);
  // The glyph, not the initials the tile falls back to.
  await expect(tile.locator("svg")).toBeVisible();
  await expect(tile).toHaveText("");
});

test("a personal space draws no appearance editor, and the route refuses one", async ({
  authedPage: page,
  orgOnlyClient,
}) => {
  const listed = await orgOnlyClient.get("/spaces");
  expect(listed.status()).toBe(200);
  const personal = ((await listed.json()).data as Array<{ id: string; personal: boolean }>).find(
    (space) => space.personal,
  )!;
  expect(personal).toBeDefined();

  const refused = await orgOnlyClient.patch(`/spaces/${personal.id}`, { icon: "lucide:rocket" });
  expect(refused.status()).toBe(409);
  expect((await refused.json()).code).toBe("personal_space_immutable");

  // Switched in place: a reload would land back in the default space the fixture pins.
  await page.goto("/workspace-settings/general");
  const settings = page.getByRole("dialog", { name: "Paramètres", exact: true });
  // The picker's colour choice: drawn for the team space the page opens on.
  const colours = settings.getByRole("radiogroup", { name: "Couleur", exact: true });
  await expect(colours).toBeVisible();
  await new Sidebar(page).switchSpaceInSettings("Mon espace");
  // The personal page is the one on screen: its one sentence says so.
  await expect(settings.getByText(/toujours privé/)).toBeVisible();
  await expect(colours).toHaveCount(0);
});
