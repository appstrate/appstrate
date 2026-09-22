// SPDX-License-Identifier: Apache-2.0

/**
 * Skills in the chat, from the browser: the picker stores the selection before
 * any message is sent, and the `/` popover inserts the directive the server
 * parses. What only a browser shows is that both surfaces work on a
 * conversation with no row yet, and that Enter-to-send is not hijacked.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSkill } from "../../helpers/seed.ts";

interface SessionRow {
  id: string;
  skill_catalogue: boolean;
  pinned_skills: string[];
}

test("hides the catalogue and pins a skill before the first message, then mentions it", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `e2e-skill-${Date.now()}`;
  await createSkill(apiClient, scope, name);
  const packageId = `${scope}/${name}`;

  await page.goto("/chat");
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeVisible();

  await page.getByTestId("skills-picker-trigger").click();
  const popover = page.getByTestId("skills-picker-popover");
  await expect(popover).toBeVisible();
  const catalogue = popover.getByTestId("skills-catalogue-toggle");
  await expect(catalogue).toBeChecked();
  await catalogue.click();
  await expect(catalogue).not.toBeChecked();
  const pin = popover.getByTestId(`skill-pin-${packageId}`);
  await pin.click();
  await expect(pin).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // The PUTs run after the clicks, through a coalescer: poll until the row settles.
  await expect
    .poll(async () => {
      const res = await apiClient.get("/chat/sessions");
      const body = (await res.json()) as { data: SessionRow[] };
      return body.data.map((s) => ({
        skill_catalogue: s.skill_catalogue,
        pinned_skills: s.pinned_skills,
      }));
    })
    .toEqual([{ skill_catalogue: false, pinned_skills: [packageId] }]);

  await composer.click();
  await composer.pressSequentially(`/${name.slice(0, 8)}`);
  const row = page.getByTestId("skill-mention-option").filter({ hasText: `/${name}` });
  await expect(row).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue(new RegExp(`:skill\\[/${name}\\]\\{name=${packageId}\\}`));
  await expect(page.getByTestId("skill-mention-popover")).toHaveCount(0);
});

test("leaves a `/word` that matches no skill alone", async ({ authedPage: page }) => {
  // An OPEN trigger swallows Enter even with no rows, so it must not open here.
  await page.goto("/chat");
  const composer = page.getByTestId("chat-composer-input");
  await expect(composer).toBeVisible();
  const popover = page.getByTestId("skill-mention-popover");

  await composer.click();
  await composer.pressSequentially("regarde /outputs");
  await expect(popover).toHaveCount(0);
  await expect(composer).toHaveValue("regarde /outputs");

  // Sent, not swallowed: the composer clears and the text reaches the thread.
  await page.keyboard.press("Enter");
  await expect(composer).toHaveValue("");
  await expect(page.getByText("regarde /outputs").first()).toBeVisible();
});
