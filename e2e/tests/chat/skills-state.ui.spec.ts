// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the server reports for a conversation, from the browser: each panel row says whether
 * its skill is in the model's context, who pinned it and, when the last turn left it out, why; a
 * skill the assistant read shows in its message as the user's skill chip, said loaded only when
 * the server pinned it. The session detail and
 * the commands are mocked, so the states are checked without a model; the turn is refused (503)
 * after its body is read.
 */

import type { Page } from "@playwright/test";
import type { components, operations } from "../../../apps/web/src/api/schema.d.ts";
import { test, expect } from "../../fixtures/browser.fixture.ts";

// Typed from the generated API types: a contract change breaks the typecheck, not the mock.
type SessionDetail = operations["getChatSession"]["responses"][200]["content"]["application/json"];

const commands: components["schemas"]["ChatCommands"] = {
  skills: [
    { id: "@acme/tone", name: "tone", description: "Adjusts the tone", version: "1.0.0" },
    { id: "@acme/auto", name: "auto", description: "Loaded by the assistant", version: "1.0.0" },
    { id: "@acme/big", name: "big", description: "Too long for the budget", version: "1.0.0" },
  ],
  agents: [],
};

const skills: SessionDetail["skills"] = [
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
    const json: SessionDetail = {
      ...((await response.json()) as SessionDetail),
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
                // What a reload serves of a pinned load: the receipt and the pin flag.
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
                  skillPinned: true,
                },
              },
              {
                // Past the pin cap the server still serves the read, with a note for the model.
                type: "tool-read_resource",
                toolCallId: "call_unpinned",
                state: "output-available",
                input: { uri: skillMd("pdf") },
                output: {
                  content: [
                    { type: "text", text: "---\nname: pdf\n---\nBody" },
                    {
                      type: "text",
                      text: "The skill `@acme/pdf` was read for this turn but not pinned to the conversation.",
                    },
                  ],
                },
              },
              {
                type: "tool-read_resource",
                toolCallId: "call_failed",
                state: "output-error",
                input: { uri: skillMd("gone") },
                errorText: "Resource not found: the skill could not be read.",
              },
            ],
          },
        },
      ],
    };
    await route.fulfill({ response, json });
  });

  await page.goto(`/chat/${id}`);

  // The assistant's reads are drawn as skill chips, said loaded only when the server pinned them;
  // the model-facing note and error are never shown.
  const loads = page.getByTestId("skill-load");
  await expect(loads).toHaveCount(3);
  await expect(loads.nth(0)).toHaveAttribute("data-state", "loaded");
  await expect(loads.nth(0).getByTestId("directive-chip")).toHaveText("auto");
  await expect(loads.nth(0).getByTestId("skill-load-live")).toHaveText("Compétence auto chargée");
  await expect(loads.nth(0).getByTestId("skill-load-state")).toHaveCount(0);
  await expect(loads.nth(1)).toHaveAttribute("data-state", "readOnly");
  await expect(loads.nth(1).getByTestId("skill-load-state")).toHaveText(
    "Lue pour ce message seulement",
  );
  await expect(loads.nth(1)).not.toContainText("chargée");
  await expect(loads.nth(1)).not.toContainText("not pinned");
  await expect(loads.nth(2)).toHaveAttribute("data-state", "refused");
  await expect(loads.nth(2).getByTestId("skill-load-state")).toHaveText("Non chargée");
  await expect(loads.nth(2)).not.toContainText("could not be read");

  // The pill counts only what is loaded: `big`, pinned but over budget, is left out (`pdf` and
  // `gone` were reads, never pins).
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
});
