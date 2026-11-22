// SPDX-License-Identifier: Apache-2.0

/**
 * Skills in the chat, from the browser: the picker's changes (pins, discovery switch) stay in the
 * page — nothing is written, no conversation is created — until a message carries them, as
 * changes and never as a full set.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSkill } from "../../helpers/seed.ts";

/** The picker sits behind the composer's settings menu (its chip shows only off the default selection). */
async function openSkillsPicker(page: Page) {
  await page.getByTestId("composer-settings-trigger").click();
  await page.getByRole("menuitem", { name: /Compétences|Skills/ }).click();
}

test("carries the skill changes and discovery with the first message, and writes nothing before", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `e2e-skill-${Date.now()}`;
  await createSkill(apiClient, scope, name);
  const packageId = `${scope}/${name}`;
  // Every chat call goes to the organization's routes (`chatRoute` for the API client, which adds `/api`).
  const chatRoute = `/orgs/${browserCtx.org.orgId}/chat`;
  const chat = `/api${chatRoute}`;

  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && req.url().includes(chat)) writes.push(req.url());
  });

  await page.goto("/chat");
  await openSkillsPicker(page);
  const popover = page.getByTestId("skills-picker-popover");
  const discovery = popover.getByTestId("skills-discovery");
  // Discovery is on by default, and the list is offered whether it is on or off.
  await expect(discovery).toHaveAttribute("data-state", "checked");
  const pin = popover.getByTestId(`skill-pin-${packageId}`);
  await expect(pin).toBeEnabled();
  await discovery.click();
  await expect(discovery).toHaveAttribute("data-state", "unchecked");
  await expect(pin).toBeEnabled();
  await pin.click();
  await expect(pin).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // The pinned skill shows as a pill in the composer, and the pill reopens the picker.
  const pinnedPill = page.getByTestId("skill-pill-pinned");
  await expect(pinnedPill).toBeVisible();
  await pinnedPill.click();
  await expect(popover).toBeVisible();
  await expect(pin).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // Choosing created nothing: same page, no conversation, no write.
  await expect(page).toHaveURL(/\/chat$/);
  const sessions = (await (await apiClient.get(`${chatRoute}/sessions`)).json()) as {
    data: unknown[];
  };
  expect(sessions.data).toEqual([]);
  expect(writes).toEqual([]);

  // The first message carries the selection; the turn itself is not the subject.
  const sent = page.waitForRequest(
    (req) => req.method() === "POST" && new URL(req.url()).pathname === chat,
  );
  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));
  await page.getByRole("textbox", { name: "Message Appstrate…", exact: true }).fill("bonjour");
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body.skill_discovery).toBe(false);
  expect(body.pin_skills).toEqual([packageId]);
  expect(body.unpin_skills).toBeUndefined();
  expect(body.pinned_skills).toBeUndefined();
});
