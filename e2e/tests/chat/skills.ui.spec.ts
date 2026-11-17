// SPDX-License-Identifier: Apache-2.0

/**
 * Skills in the chat, from the browser: the picker's mode and chosen skills
 * stay in the page — nothing is written, no conversation is created — until a
 * message carries them.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSkill } from "../../helpers/seed.ts";

/** The picker sits behind the composer's « + » menu (its chip shows only off the defaults). */
async function openSkillsPicker(page: Page) {
  await page.getByTestId("composer-tools-trigger").click();
  await page.getByRole("menuitem", { name: /Compétences|Skills/ }).click();
}

test("carries the chosen mode and skills with the first message, and writes nothing before", async ({
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
  const auto = popover.getByTestId("skills-mode-auto");
  const manual = popover.getByTestId("skills-mode-manual");
  await expect(auto).toHaveAttribute("data-state", "active");
  // In auto the assistant chooses among the catalogue: the picker lists no skill to choose.
  const pin = popover.getByTestId(`skill-pin-${packageId}`);
  await expect(pin).toHaveCount(0);
  await manual.click();
  await expect(manual).toHaveAttribute("data-state", "active");
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
  await page.getByPlaceholder("Message Appstrate…").fill("bonjour");
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { skill_mode?: string; pinned_skills?: string[] };
  expect(body.skill_mode).toBe("manual");
  expect(body.pinned_skills).toEqual([packageId]);
});
