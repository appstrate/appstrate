// SPDX-License-Identifier: Apache-2.0

/**
 * Skills in the chat, from the browser: the picker stores the selection on a
 * conversation that has no row yet, before any message is sent, and the URL
 * adopts that conversation so a reload reopens it.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSkill } from "../../helpers/seed.ts";

interface SessionRow {
  id: string;
  skill_catalogue: boolean;
  pinned_skills: string[];
}

test("hides the catalogue and pins a skill before the first message", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `e2e-skill-${Date.now()}`;
  await createSkill(apiClient, scope, name);
  const packageId = `${scope}/${name}`;

  await page.goto("/chat");
  const trigger = page.getByTestId("skills-picker-trigger");
  await expect(trigger).toBeVisible();

  await trigger.click();
  const popover = page.getByTestId("skills-picker-popover");
  await expect(popover).toBeVisible();
  const catalogue = popover.getByTestId("skills-catalogue-toggle");
  await expect(catalogue).toBeChecked();
  await catalogue.click();
  await expect(catalogue).not.toBeChecked();
  const pin = popover.getByTestId(`skill-pin-${packageId}`);
  await expect(pin).toBeEnabled();
  await pin.click();
  await expect(pin).toBeChecked();
  // The controls are disabled while a write is in flight: enabled again means
  // the second PUT has answered, so one read is enough.
  await expect(pin).toBeEnabled();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  const res = await apiClient.get("/chat/sessions");
  const body = (await res.json()) as { data: SessionRow[] };
  expect(
    body.data.map((s) => ({ skill_catalogue: s.skill_catalogue, pinned_skills: s.pinned_skills })),
  ).toEqual([{ skill_catalogue: false, pinned_skills: [packageId] }]);

  // The URL holds the conversation the pins were written to; a reload reopens it.
  const sessionId = body.data[0]!.id;
  await expect(page).toHaveURL(new RegExp(`/chat/${sessionId}$`));
  await page.reload();
  await trigger.click();
  await expect(popover.getByTestId("skills-catalogue-toggle")).not.toBeChecked();
  await expect(popover.getByTestId(`skill-pin-${packageId}`)).toBeChecked();
});
