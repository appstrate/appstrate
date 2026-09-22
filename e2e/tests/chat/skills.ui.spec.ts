// SPDX-License-Identifier: Apache-2.0

/**
 * Skills in the chat, from the browser (docs/plans/chat-skills.md, phases 3-4).
 *
 * The picker writes the conversation's skill selection before any message is
 * sent — the server creates the session row on that write — and the `/`
 * popover inserts the exact directive the server parses back on every turn.
 * Route tests cover each half; what only a browser shows is that the two
 * surfaces read one cache entry and that the composer's own Enter-to-send is
 * not hijacked by the trigger.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSkill } from "../../helpers/seed.ts";

const COMPOSER = "textarea[placeholder='Message Appstrate…']";

test("pins a skill before the first message, then mentions it with /", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `e2e-skill-${Date.now()}`;
  await createSkill(apiClient, scope, name);
  const packageId = `${scope}/${name}`;

  await page.goto("/chat");
  await expect(page.locator(COMPOSER)).toBeVisible();

  // ── Picker: manual mode + one pin, on a conversation with no row yet ──────
  await page.getByRole("button", { name: "Compétences", exact: true }).click();
  const popover = page.getByRole("dialog", { name: "Compétences de la conversation" });
  await expect(popover).toBeVisible();
  // `click` + `toBeChecked`, not `check()`: the state lands on the next render
  // (optimistic cache patch), and `check()` reads it synchronously after the click.
  const manual = popover.getByRole("radio", { name: "Manuelle" });
  await manual.click();
  await expect(manual).toBeChecked();
  // By accessible name: the checkbox gets it from its `<label htmlFor>`, whose
  // `id` is a slug of the package id — so this also proves the pairing survives.
  const pin = popover.getByRole("checkbox", { name: `Test Skill ${name}` });
  await pin.click();
  await expect(pin).toBeChecked();
  await page.screenshot({ path: "test-results/chat-skills-picker.png" });
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // The write created the session: the list carries the mode, the detail the pin.
  await expect
    .poll(async () => {
      const res = await apiClient.get("/chat/sessions");
      const body = (await res.json()) as { data: { id: string; skill_discovery: string }[] };
      return body.data.map((s) => s.skill_discovery);
    })
    .toEqual(["manual"]);
  const list = (await (await apiClient.get("/chat/sessions")).json()) as {
    data: { id: string }[];
  };
  const detail = (await (await apiClient.get(`/chat/sessions/${list.data[0]!.id}`)).json()) as {
    pinned_skills: string[];
  };
  expect(detail.pinned_skills).toEqual([packageId]);

  // ── `/` mention: the popover lists the skill and inserts the directive ────
  const composer = page.locator(COMPOSER);
  await composer.click();
  await composer.pressSequentially(`/${name.slice(0, 8)}`);
  const row = page.getByRole("option", { name: new RegExp(`/${name}`) });
  await expect(row).toBeVisible();
  await page.screenshot({ path: "test-results/chat-skills-mention.png" });
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue(new RegExp(`:skill\\[/${name}\\]\\{name=${packageId}\\}`));
  // The insertion closed the popover: no row survives the selection.
  await expect(page.getByRole("option")).toHaveCount(0);
});

test("leaves a `/word` that matches no skill alone", async ({ authedPage: page }) => {
  // The trigger's matcher, from the outside. An OPEN trigger swallows Enter
  // even with zero matching items, so a popover that opened here would make
  // `regarde /outputs` unsendable — the feature breaking a message that has
  // nothing to do with skills.
  await page.goto("/chat");
  const composer = page.locator(COMPOSER);
  await expect(composer).toBeVisible();

  // The popover element itself, not its rows: with no matcher it OPENS on any
  // word-initial `/` and renders its empty state, which has no `option` in it —
  // so counting rows would pass either way.
  const popover = page.locator('[aria-label="Compétences à charger"]');

  await composer.click();
  await composer.pressSequentially("regarde /outputs");
  await expect(popover).toHaveCount(0);
  await expect(page.getByRole("option")).toHaveCount(0);
  await expect(composer).toHaveValue("regarde /outputs");

  await page.keyboard.press("Enter");
  // Still closed: Enter went to the composer, not to a trigger selection.
  await expect(popover).toHaveCount(0);
});
