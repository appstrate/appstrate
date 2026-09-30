// SPDX-License-Identifier: Apache-2.0

/**
 * Skills in the chat, from the browser: the picker's mode and chosen skills
 * stay in the page — nothing is written, no conversation is created — until a
 * message carries them. A skill the space imposes is set from the space
 * library, behind a confirmation, and reaches the picker locked.
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

test("a skill imposed from the space library is locked in the picker, after a confirmation", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `e2e-enforced-${Date.now()}`;
  // Created in the default space: published (`0.1.0`) and active there, which
  // is all imposing asks of it.
  await createSkill(apiClient, scope, name);
  const packageId = `${scope}/${name}`;

  await page.goto("/space/packages#skills");
  const row = page.getByRole("row").filter({ hasText: `Test Skill ${name}` });
  const enforce = row.getByRole("checkbox", { name: /dans le chat|in the chat/ });
  await expect(enforce).not.toBeChecked();
  await enforce.click();

  // Imposing discloses the content to every member who chats here: the reader
  // is told so before anything is written.
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText(/quels que soient leurs droits|whatever their skill/);
  const patched = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      response.url().includes(`/packages/${scope}/${name}`),
  );
  await dialog.getByRole("button", { name: /^(Imposer|Require)$/ }).click();
  expect((await patched).status()).toBe(200);
  await expect(enforce).toBeChecked();

  // The composer lists it first, checked and locked, and not among the choices.
  await page.goto("/chat");
  await page.getByTestId("skills-picker-trigger").click();
  const popover = page.getByTestId("skills-picker-popover");
  const locked = popover.getByTestId(`skill-enforced-${packageId}`);
  await expect(locked).toBeChecked();
  await expect(locked).toBeDisabled();
  await expect(popover.getByText(/Imposée par l'espace|Required by the space/)).toBeVisible();
  await expect(popover.getByTestId(`skill-pin-${packageId}`)).toHaveCount(0);
});
