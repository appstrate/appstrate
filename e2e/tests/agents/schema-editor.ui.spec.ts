// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";

test("schema rows survive menu editing, rename, keyboard/pointer reorder, discard and reload", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}, testInfo) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `schema-${Date.now()}`;
  const id = `${scope}/${name}`;
  const created = await apiClient.post("/packages/agents", {
    manifest: {
      schema_version: "0.1",
      name: id,
      display_name: "Schema editor regression",
      version: "0.1.0",
      type: "agent",
      description: "Schema editor regression",
      input: {
        schema: {
          type: "object",
          properties: {
            first: { type: "string", description: "First description" },
            second: { type: "number", minimum: 2 },
            third: { type: "boolean" },
          },
        },
        property_order: ["first", "second", "third"],
      },
    },
    content: "Schema editor regression",
  });
  expect(created.status(), await created.text()).toBe(201);
  await page.goto(`/agents/${id}?agentSettings=schema#settings`);
  const input = page.getByRole("region", { name: "Entrées (input)", exact: true });
  const row = (key: string) =>
    input.getByRole("row").filter({ has: page.getByRole("cell", { name: key, exact: true }) });
  const edit = async (key: string) => {
    await row(key)
      .getByRole("button", { name: `Actions pour ${key}`, exact: true })
      .click();
    await page.getByRole("menuitem", { name: "Modifier", exact: true }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
  };

  // A menu item disappears; focus must return to the menu's still-mounted trigger.
  await edit("first");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(
    row("first").getByRole("button", { name: "Actions pour first", exact: true }),
  ).toBeFocused();

  await edit("first");
  await page.getByRole("dialog").getByRole("textbox").first().fill("renamed");
  await page.getByRole("button", { name: "Appliquer", exact: true }).click();
  await expect(row("renamed")).toBeVisible();
  await edit("renamed");
  await expect(page.getByRole("dialog").getByRole("textbox").first()).toHaveValue("renamed");
  await page.keyboard.press("Escape");

  // Stable property keys let DnD retain row identity after deriving from the manifest.
  await input.getByRole("button", { name: "Déplacer renamed", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(
    input.getByRole("button", { name: "Déplacer renamed", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("ArrowDown");
  await expect(input.getByRole("status")).toContainText("over droppable area second");
  await page.keyboard.press("Enter");
  await expect(
    input.getByRole("button", { name: "Déplacer renamed", exact: true }),
  ).not.toHaveAttribute("aria-pressed", "true");
  const keys = () => input.getByRole("row").locator("td:nth-child(2)").allTextContents();
  await expect.poll(keys).toEqual(["second", "renamed", "third"]);

  const from = await input
    .getByRole("button", { name: "Déplacer third", exact: true })
    .boundingBox();
  const to = await input
    .getByRole("button", { name: "Déplacer second", exact: true })
    .boundingBox();
  expect(from).not.toBeNull();
  expect(to).not.toBeNull();
  await page.mouse.move(from!.x + from!.width / 2, from!.y + from!.height / 2);
  await page.mouse.down();
  await page.mouse.move(to!.x + to!.width / 2, to!.y + to!.height / 2, { steps: 12 });
  await page.mouse.up();
  await expect.poll(keys).toEqual(["third", "second", "renamed"]);

  // DnD suppresses the click immediately following a pointer drop.
  await expect(async () => {
    await page.getByRole("button", { name: "Annuler les modifications", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Annuler les modifications", exact: true }),
    ).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await expect.poll(keys).toEqual(["first", "second", "third"]);
  await edit("first");
  await page.getByRole("dialog").getByRole("textbox").first().fill("saved");
  await page.getByRole("button", { name: "Appliquer", exact: true }).click();
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  await expect(page.getByRole("button", { name: "Enregistrer", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(row("saved")).toBeVisible();
  const detail = await apiClient.get(`/packages/agents/${id}`);
  expect(detail.status(), await detail.text()).toBe(200);
  const manifest = (await detail.json()).manifest;
  expect(manifest.input.schema.properties.saved).toEqual({
    type: "string",
    description: "First description",
  });
  expect(manifest.input.schema.properties.second).toEqual({ type: "number", minimum: 2 });

  // Whole-manifest replacement updates the form without a parallel schema state.
  manifest.input.schema.properties.raw = { type: "boolean" };
  manifest.input.property_order = ["raw", "saved", "second", "third"];
  await page.goto(`/agents/${id}?agentSettings=schema&editManifest=1#settings`);
  const jsonDialog = page.getByRole("dialog");
  const lines = jsonDialog.locator(".monaco-editor .view-lines");
  await expect(lines).toBeVisible();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(
    (text) => navigator.clipboard.writeText(text),
    JSON.stringify(manifest, null, 2),
  );
  await expect(async () => {
    await lines.click();
    await expect(jsonDialog.locator(".monaco-editor.focused")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("ControlOrMeta+V");
    await expect(lines).toContainText('"raw"', { timeout: 1000 });
  }).toPass();
  await jsonDialog.getByRole("button", { name: "Appliquer au formulaire", exact: true }).click();
  await expect(jsonDialog).toHaveCount(0);
  await expect.poll(keys).toEqual(["raw", "saved", "second", "third"]);
  await page.getByRole("button", { name: "Annuler les modifications", exact: true }).click();
  await expect.poll(keys).toEqual(["saved", "second", "third"]);
  await page.screenshot({ path: testInfo.outputPath("schema-editor-verified.png") });
});
