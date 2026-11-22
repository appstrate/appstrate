// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `/` menu, from the browser: assistant-ui's trigger popover over a Lexical field,
 * where a chosen skill or agent stays in the text as an atomic inline chip. The route that feeds
 * the menu (`GET /chat/commands`) is mocked, so it is checked against known skills and agents
 * rather than the seed's; the turn is refused (503) after its body is read, no model is called.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures/browser.fixture.ts";

const commands = {
  skills: [
    { id: "@acme/tone", name: "tone", description: "Adjusts the tone of a text", version: "1.2.0" },
    { id: "@acme/pdf", name: "pdf", description: "Reads PDF files", version: null },
  ],
  agents: [
    {
      name: "run-report",
      title: "Weekly report",
      description: "Builds the weekly report",
      packageId: "@acme/report",
      icon: null,
      color: null,
    },
  ],
};

async function mockCommands(page: Page, orgId: string) {
  await page.route(`**/api/orgs/${orgId}/chat/commands*`, (route) =>
    route.fulfill({ json: commands }),
  );
}

const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Appstrate…", exact: true });

const chatPost = (chat: string) => (req: { method(): string; url(): string }) =>
  req.method() === "POST" && new URL(req.url()).pathname === chat;

test("filters, selects with the keyboard or the mouse, and never sends while open", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  await mockCommands(page, browserCtx.org.orgId);
  const sent: string[] = [];
  page.on("request", (req) => {
    if (chatPost(chat)(req)) sent.push(req.url());
  });

  await page.goto("/chat");
  const input = composer(page);
  await input.click();
  await input.fill("/");

  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("group", { name: "Compétences", exact: true })).toBeVisible();
  // The billed-run notice is the Agents heading's, once.
  await expect(
    menu.getByRole("group", { name: /Agents · lancent une exécution facturée/ }),
  ).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(3);
  // An agent shows its title and prompt name, no description.
  await expect(menu.getByRole("option", { name: /Weekly report/ })).toContainText("/run-report");

  // The text after the slash filters, case-insensitively; the field keeps the focus.
  await input.fill("/TON");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(input).toBeFocused();

  // Enter selects: the skill stays in the text as a chip, the typed token is gone, nothing is sent.
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(input.getByTestId("directive-chip")).toHaveText("tone");
  await expect(input).not.toContainText("/TON");
  expect(sent).toEqual([]);

  // Arrow keys move the highlight.
  await page.keyboard.type(" /");
  const first = await input.getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  expect(await input.getAttribute("aria-activedescendant")).not.toBe(first);

  // Escape closes and keeps the text.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(input).toContainText("/");

  // A click selects too.
  await page.keyboard.press("Backspace");
  await page.keyboard.type("/pd");
  await menu.getByRole("option", { name: /pdf/ }).click();
  await expect(input.getByTestId("directive-chip")).toHaveText(["tone", "pdf"]);

  // The chip is atomic: the space the menu leaves after it goes first, then one Backspace removes
  // the chip whole.
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await expect(input.getByTestId("directive-chip")).toHaveText(["tone"]);
});

test("a path-like /name with no match is sent as ordinary text", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  await mockCommands(page, browserCtx.org.orgId);
  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));

  await page.goto("/chat");
  const input = composer(page);
  await input.fill("/nothing-like-this");
  await expect(page.getByTestId("slash-menu")).toBeHidden();

  const sent = page.waitForRequest(chatPost(chat));
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as {
    messages: { parts: { type: string; text?: string }[] }[];
  };
  expect(body.messages.at(-1)!.parts).toEqual([{ type: "text", text: "/nothing-like-this" }]);
});

test("an agent chip is a message of its own: its text part and its prompt part, once", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  await mockCommands(page, browserCtx.org.orgId);
  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));

  await page.goto("/chat");
  const input = composer(page);
  await input.fill("/run");
  // The menu fills once the commands are read: a key sent before then is the field's own.
  await expect(page.getByRole("option", { name: /Weekly report/ })).toBeVisible();
  await page.keyboard.press("Tab");
  const chip = input.getByTestId("directive-chip");
  await expect(chip).toHaveText("Weekly report");

  // One agent per message: the menu offers no second one.
  await page.keyboard.type(" /");
  await expect(page.getByTestId("slash-menu").getByRole("option", { name: /Weekly/ })).toHaveCount(
    0,
  );
  await page.keyboard.press("Escape");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");

  const sent = page.waitForRequest(chatPost(chat));
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as {
    messages: { role: string; parts: { type: string; text?: string; data?: unknown }[] }[];
  };
  expect(body.messages.at(-1)!.parts).toEqual([
    { type: "text", text: ":agent[Weekly report]{name=run-report}" },
    { type: "data-agent-prompt", data: { name: "run-report", title: "Weekly report" } },
  ]);
  // The thread shows the chip in the bubble, where it was typed; the composer is empty.
  await expect(
    page.locator("[data-testid=directive-chip]", { hasText: "Weekly report" }),
  ).toBeVisible();
  await expect(input.getByTestId("directive-chip")).toHaveCount(0);
});

test("a skill chip pins the skill with the message that carries it", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  await mockCommands(page, browserCtx.org.orgId);
  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));

  await page.goto("/chat");
  const input = composer(page);
  await input.fill("/tone");
  await expect(page.getByRole("option", { name: /tone/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("make it shorter");
  const sent = page.waitForRequest(chatPost(chat));
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as {
    pin_skills?: string[];
    unpin_skills?: string[];
    messages: { parts: { type: string; text?: string }[] }[];
  };
  expect(body.pin_skills).toEqual(["@acme/tone"]);
  expect(body.unpin_skills).toBeUndefined();
  expect(body.messages.at(-1)!.parts).toEqual([
    { type: "text", text: ":skill[tone]{name=@acme/tone} make it shorter" },
  ]);
});

// The popover's own loading hold (assistant-ui) keeps Enter and Tab from sending a `/token` while
// the commands load; this guards it across library upgrades.
test("Enter and Tab inside a /token wait for the commands instead of sending it", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route(`**/api/orgs/${browserCtx.org.orgId}/chat/commands*`, async (route) => {
    await gate;
    await route.fulfill({ json: commands });
  });
  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));
  const sent: string[] = [];
  page.on("request", (req) => {
    if (chatPost(chat)(req)) sent.push(req.url());
  });

  await page.goto("/chat");
  const input = composer(page);
  await input.fill("/tone");
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(300);
  expect(sent).toEqual([]);
  await expect(input).toContainText("/tone");

  release();
  await expect(page.getByRole("option", { name: /tone/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(input.getByTestId("directive-chip")).toHaveText("tone");
  expect(sent).toEqual([]);
});
