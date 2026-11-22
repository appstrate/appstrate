// SPDX-License-Identifier: Apache-2.0

/**
 * « Réessayer » on a failed turn: it sends the retry prompt as a new turn, throws nothing in the
 * page, and leaves the draft the user is typing in the composer untouched.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import frChat from "../../../apps/web/src/locales/fr/chat.json" with { type: "json" };

const retryPrompt = frChat["turn.retryPrompt"];

type ChatBody = {
  messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
};

function lastUserText(body: ChatBody): string {
  const message = body.messages.findLast((m) => m.role === "user");
  return (message?.parts ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
}

test("retrying a failed turn sends the retry prompt, keeps the draft and throws nothing", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  const bodies: ChatBody[] = [];
  await page.route(`**${chat}`, (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    bodies.push(route.request().postDataJSON() as ChatBody);
    return route.fulfill({ status: 503, body: "" });
  });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));

  await page.goto("/chat");
  const composer = page.getByRole("textbox", { name: "Message Appstrate…", exact: true });
  await composer.fill("bonjour");
  await page.keyboard.press("Enter");

  const retry = page.getByRole("button", { name: "Réessayer", exact: true });
  await expect(page.getByRole("alert").first()).toBeVisible();
  await expect(retry).toBeVisible();
  expect(bodies).toHaveLength(1);

  await composer.fill("brouillon");
  await retry.click();

  await expect.poll(() => bodies.length).toBe(2);
  expect(lastUserText(bodies[1]!)).toBe(retryPrompt);
  await expect(composer).toHaveText("brouillon");
  expect(pageErrors).toEqual([]);
});
