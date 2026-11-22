// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the server reports for a conversation, from the browser: each panel row says whether
 * its skill is in the model's context, who pinned it and, when the last turn left it out, why; a
 * skill the assistant loaded shows in its message as the user's skill chip. The session detail and
 * the commands are mocked, so the states are checked without a model; the turn is refused (503)
 * after its body is read.
 */

import type { Page } from "@playwright/test";
import { test, expect } from "../../fixtures/browser.fixture.ts";

const commands = {
  skills: [
    { id: "@acme/tone", name: "tone", description: "Adjusts the tone", version: "1.0.0" },
    { id: "@acme/auto", name: "auto", description: "Loaded by the assistant", version: "1.0.0" },
    { id: "@acme/big", name: "big", description: "Too long for the budget", version: "1.0.0" },
  ],
  agents: [],
};

const skills = [
  { id: "@acme/auto", source: "assistant", status: "injected" },
  { id: "@acme/big", source: "user", status: "over_budget" },
  { id: "@acme/tone", source: "user", status: "injected" },
];

async function openSkillsPicker(page: Page) {
  await page.getByTestId("composer-settings-trigger").click();
  await page.getByRole("menuitem", { name: /Compétences|Skills/ }).click();
}

test("the panel reports each pin's state and source, and an unchecked assistant pin is unpinned", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const orgId = browserCtx.org.orgId;
  const spaceId = browserCtx.org.defaultSpaceId;
  const chat = `/api/orgs/${orgId}/chat`;
  const created = await orgOnlyClient.post(`/orgs/${orgId}/chat/sessions`, { title: "Skills" });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const skillMd = (pkg: string) => `skill://${spaceId}/acme/${pkg}/${pkg}/SKILL.md`;
  await page.route(`**/api/orgs/${orgId}/chat/commands*`, (route) =>
    route.fulfill({ json: commands }),
  );
  await page.route(`**${chat}/sessions/${id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        skill_discovery: true,
        skills,
        messages: [
          {
            id: "load",
            content: {
              role: "assistant",
              parts: [
                {
                  type: "tool-read_resource",
                  toolCallId: "call_auto",
                  state: "output-available",
                  input: { uri: skillMd("auto") },
                  // What a reload serves: the receipt, never the skill's body.
                  output: {
                    content: [
                      {
                        type: "text",
                        text: JSON.stringify({
                          uri: skillMd("auto"),
                          skill: "@acme/auto",
                          pinned: true,
                        }),
                      },
                    ],
                  },
                },
                {
                  type: "tool-read_resource",
                  toolCallId: "call_refused",
                  state: "output-error",
                  input: { uri: skillMd("pdf") },
                  errorText: "This conversation already pins 5 skills.",
                },
              ],
            },
          },
        ],
      },
    });
  });

  await page.goto(`/chat/${id}`);

  // The assistant's loads are drawn as skill chips, the refused one muted and said not loaded in
  // the user's language (the model-facing error is never shown).
  const loads = page.getByTestId("skill-load");
  await expect(loads).toHaveCount(2);
  await expect(loads.nth(0)).toHaveAttribute("data-phase", "success");
  await expect(loads.nth(0).getByTestId("directive-chip")).toHaveText("auto");
  await expect(loads.nth(1)).toHaveAttribute("data-phase", "error");
  await expect(loads.nth(1).getByTestId("skill-load-state")).toHaveText(
    "Non chargée : la conversation est pleine ou le budget de compétences est dépassé",
  );
  await expect(loads.nth(1)).not.toContainText("already pins");

  // The pill counts only what is loaded: the refused pin is left out.
  await expect(page.getByTestId("skill-pill-pinned")).toHaveText(/^\s*2 ajoutées\s*$/);

  await openSkillsPicker(page);
  const popover = page.getByTestId("skills-picker-popover");
  const row = (pkg: string) => popover.getByTestId(`skill-pin-@acme/${pkg}`);
  const caption = (pkg: string) => popover.getByTestId(`skill-pin-state-@acme/${pkg}`);

  await expect(row("auto")).toBeChecked();
  await expect(row("auto")).toBeEnabled();
  await expect(caption("auto")).toHaveText("Chargée par l'assistant");
  await expect(row("big")).toBeChecked();
  await expect(row("big")).toBeEnabled();
  await expect(caption("big")).toHaveText("Non chargée : budget de compétences dépassé");
  await expect(row("tone")).toBeChecked();
  await expect(caption("tone")).toHaveCount(0);

  // Only the draft locks: the assistant's pin unchecks, and the next turn sends that change only.
  await row("auto").click();
  await expect(row("auto")).not.toBeChecked();
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  await page.route(`**${chat}`, (route) => route.fulfill({ status: 503, body: "" }));
  const sent = page.waitForRequest(
    (req) => req.method() === "POST" && new URL(req.url()).pathname === chat,
  );
  await page.getByRole("textbox", { name: "Message Appstrate…", exact: true }).fill("bonjour");
  await page.keyboard.press("Enter");
  const body = (await sent).postDataJSON() as Record<string, unknown>;
  expect(body.unpin_skills).toEqual(["@acme/auto"]);
  expect(body.pin_skills).toBeUndefined();
  expect(body.skill_discovery).toBeUndefined();
  expect(body.pinned_skills).toBeUndefined();
});
