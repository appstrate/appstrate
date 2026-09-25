// SPDX-License-Identifier: Apache-2.0

/**
 * Skills in the chat, from the browser: the picker's mode and chosen skills
 * stay in the page — nothing is written, no conversation is created — until a
 * message carries them.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSkill } from "../../helpers/seed.ts";

test("carries the chosen mode and skills with the first message, and writes nothing before", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `e2e-skill-${Date.now()}`;
  await createSkill(apiClient, scope, name);
  const packageId = `${scope}/${name}`;

  const writes: string[] = [];
  page.on("request", (req) => {
    if (req.method() !== "GET" && req.url().includes("/api/chat")) writes.push(req.url());
  });

  await page.goto("/chat");
  const trigger = page.getByTestId("skills-picker-trigger");
  await trigger.click();
  const popover = page.getByTestId("skills-picker-popover");
  const auto = popover.getByTestId("skills-mode-auto");
  const manual = popover.getByTestId("skills-mode-manual");
  await expect(auto).toHaveAttribute("data-state", "active");
  // In auto the assistant chooses: the list is inert.
  const pin = popover.getByTestId(`skill-pin-${packageId}`);
  await expect(pin).toBeDisabled();
  await manual.click();
  await expect(manual).toHaveAttribute("data-state", "active");
  await pin.click();
  await expect(pin).toBeChecked();
  await page.keyboard.press("Escape");

  // Choosing created nothing: same page, no conversation, no write.
  await expect(page).toHaveURL(/\/chat$/);
  const sessions = (await (await apiClient.get("/chat/sessions")).json()) as { data: unknown[] };
  expect(sessions.data).toEqual([]);
  expect(writes).toEqual([]);

  // The first message carries the selection; the turn itself is not the subject.
  const sent = page.waitForRequest(
    (req) => req.method() === "POST" && new URL(req.url()).pathname === "/api/chat",
  );
  await page.route("**/api/chat", (route) => route.fulfill({ status: 503, body: "" }));
  await page.getByPlaceholder("Message Appstrate…").fill("bonjour");
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as { skill_mode?: string; pinned_skills?: string[] };
  expect(body.skill_mode).toBe("manual");
  expect(body.pinned_skills).toEqual([packageId]);
});
