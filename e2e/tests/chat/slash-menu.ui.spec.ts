// SPDX-License-Identifier: Apache-2.0

/**
 * The composer's `/` menu, from the browser. The route that feeds it (`GET /chat/commands`) is
 * mocked, so the menu is checked against known skills and agents rather than the seed's; the
 * turn is refused (503) after its body is read, no model is called.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures/browser.fixture.ts";

const commands = {
  skills: [
    { id: "@acme/tone", name: "tone", description: "Adjusts the tone of a text", version: "1.2.0" },
    { id: "@acme/pdf", name: "pdf", description: "Reads PDF files", version: null },
  ],
  agents: [{ name: "run-report", title: "Weekly report", description: "Builds the weekly report" }],
};

async function mockCommands(page: Page, orgId: string) {
  await page.route(`**/api/orgs/${orgId}/chat/commands*`, (route) =>
    route.fulfill({ json: commands }),
  );
}

const composer = (page: Page) =>
  page.getByRole("textbox", { name: "Message Appstrate…", exact: true });

test("filters, selects with the keyboard or the mouse, and never sends while open", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  await mockCommands(page, browserCtx.org.orgId);
  const sent: string[] = [];
  page.on("request", (req) => {
    if (req.method() === "POST" && new URL(req.url()).pathname === chat) sent.push(req.url());
  });

  await page.goto("/chat");
  const input = composer(page);
  await input.click();
  await input.fill("/");

  const menu = page.getByTestId("slash-menu");
  await expect(menu.getByRole("listbox")).toBeVisible();
  await expect(menu.getByRole("group", { name: "Compétences" })).toBeVisible();
  // The billed-run notice is the Agents heading's, once.
  await expect(
    menu.getByRole("group", { name: /Agents · lancent une exécution facturée/ }),
  ).toBeVisible();
  await expect(menu.getByRole("option")).toHaveCount(3);
  // An agent shows its title and command name, no description.
  await expect(menu.getByRole("option", { name: /Weekly report/ })).toContainText("/run-report");

  // The text after the slash filters, case-insensitively; the input keeps the focus.
  await input.fill("/TON");
  await expect(menu.getByRole("option")).toHaveCount(1);
  await expect(input).toBeFocused();

  // Enter selects: the skill is pinned, the token is gone, and nothing is sent.
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue("");
  await expect(page.getByTestId("skill-pill-pinned")).toBeVisible();
  expect(sent).toEqual([]);

  // Arrow keys move the active option, aria-activedescendant follows.
  await input.fill("/");
  const first = await input.getAttribute("aria-activedescendant");
  await page.keyboard.press("ArrowDown");
  expect(await input.getAttribute("aria-activedescendant")).not.toBe(first);

  // Escape closes and keeps the text.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue("/");

  // A click selects too; an already pinned skill only closes the menu.
  await input.fill("/to");
  await menu.getByRole("option", { name: /tone/ }).click();
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue("");
});

test("an unknown /name is sent as ordinary text", async ({ authedPage: page, browserCtx }) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  await mockCommands(page, browserCtx.org.orgId);
  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));

  await page.goto("/chat");
  const input = composer(page);
  await input.fill("/nothing-like-this");
  await expect(page.getByTestId("slash-menu")).toBeHidden();

  const sent = page.waitForRequest(
    (req) => req.method() === "POST" && new URL(req.url()).pathname === chat,
  );
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as {
    messages: { role: string; parts: { type: string; text?: string }[] }[];
  };
  const last = body.messages.at(-1)!;
  expect(last.parts).toEqual([{ type: "text", text: "/nothing-like-this" }]);
});

test("an agent becomes a chip and the message carries its prompt part", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  await mockCommands(page, browserCtx.org.orgId);
  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));

  await page.goto("/chat");
  const input = composer(page);
  await input.fill("/run");
  await page
    .getByTestId("slash-menu")
    .getByRole("option", { name: /Weekly report/ })
    .click();

  const chip = page.getByTestId("composer-agent-chip");
  await expect(chip).toContainText("Weekly report");
  await expect(input).toHaveValue("");

  // The chip is removable.
  await chip.getByRole("button", { name: /Retirer l’agent/ }).click();
  await expect(chip).toBeHidden();

  // An agent alone is a message: the text part is absent, the prompt part carries name and title.
  await input.fill("/run");
  await page.keyboard.press("Tab");
  await expect(chip).toBeVisible();
  const sent = page.waitForRequest(
    (req) => req.method() === "POST" && new URL(req.url()).pathname === chat,
  );
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as {
    messages: { role: string; parts: { type: string; data?: unknown }[] }[];
  };
  expect(body.messages.at(-1)!.parts).toEqual([
    { type: "data-agent-prompt", data: { name: "run-report", title: "Weekly report" } },
  ]);
  // The thread shows the chip at once; the chip leaves the composer.
  await expect(page.getByTestId("agent-prompt-chip")).toContainText("Weekly report");
  await expect(chip).toBeHidden();
});

test("a command typed in one go pins the skill and sends the rest as the text", async ({
  authedPage: page,
  browserCtx,
}) => {
  const chat = `/api/orgs/${browserCtx.org.orgId}/chat`;
  await mockCommands(page, browserCtx.org.orgId);
  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));

  await page.goto("/chat");
  await composer(page).fill("/tone make it shorter");
  const sent = page.waitForRequest(
    (req) => req.method() === "POST" && new URL(req.url()).pathname === chat,
  );
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as {
    pinned_skills?: string[];
    messages: { parts: { type: string; text?: string }[] }[];
  };
  expect(body.pinned_skills).toEqual(["@acme/tone"]);
  expect(body.messages.at(-1)!.parts).toEqual([{ type: "text", text: "make it shorter" }]);
});
