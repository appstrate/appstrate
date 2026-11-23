// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the server reports for a conversation, from the browser: each pinned row in the panel
 * is loaded, or not loaded with the last turn's reason; a skill the assistant read shows in its
 * message as the user's skill chip, read for that message only, with an action that pins it. The
 * session detail, its skills PATCH and the commands are mocked, so the states are checked without
 * a model.
 */

import type { Page } from "@playwright/test";
import type { components, operations } from "../../../apps/web/src/api/schema.d.ts";
import { test, expect } from "../../fixtures/browser.fixture.ts";

// Typed from the generated API types: a contract change breaks the typecheck, not the mock.
type SessionDetail = operations["getChatSession"]["responses"][200]["content"]["application/json"];
type Pin = components["schemas"]["ChatSession"]["pins"][number];

const commands: components["schemas"]["ChatCommands"] = {
  skills: [
    {
      id: "@acme/read",
      name: "read",
      description: "Reference notes",
      version: "1.0.0",
      bytes: 2000,
    },
    {
      id: "@acme/big",
      name: "big",
      description: "Too long for the budget",
      version: "1.0.0",
      bytes: 70000,
    },
    {
      id: "@acme/fresh",
      name: "fresh",
      description: "Pinned since the last turn",
      version: "1.0.0",
      bytes: 3000,
    },
    {
      id: "@acme/tone",
      name: "tone",
      description: "Adjusts the tone",
      version: "1.0.0",
      bytes: 1000,
    },
  ],
  agents: [],
};

async function openSkillsPicker(page: Page) {
  await page.getByTestId("composer-settings-trigger").click();
  await page.getByRole("menuitem", { name: /Compétences|Skills/ }).click();
}

test("the panel reports each pin's state, and a skill the assistant read is pinned from its chip", async ({
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

  // The server's row: the PATCH mock writes it, the detail mock serves it.
  let pins: Pin[] = [
    { id: "@acme/big", status: "over_budget", chars: 70000 },
    { id: "@acme/fresh", status: null, chars: null },
    { id: "@acme/tone", status: "injected", chars: 1000 },
  ];
  const skillMd = (pkg: string) => `skill://${spaceId}/acme/${pkg}/${pkg}/SKILL.md`;
  const read = (toolCallId: string, pkg: string) => ({
    type: "tool-read_resource",
    toolCallId,
    state: "output-available",
    input: { uri: skillMd(pkg) },
    output: { content: [{ type: "text", text: `---\nname: ${pkg}\n---\nBody` }] },
  });
  await page.route(`**/api/orgs/${orgId}/chat/commands*`, (route) =>
    route.fulfill({ json: commands }),
  );
  await page.route(`**${chat}/sessions/${id}`, async (route) => {
    const response = await route.fetch();
    const json: SessionDetail = {
      ...((await response.json()) as SessionDetail),
      skill_discovery: true,
      pins,
      messages: [
        {
          id: "load",
          content: {
            role: "assistant",
            parts: [
              read("call_read", "read"),
              read("call_tone", "tone"),
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
  const patches: unknown[] = [];
  await page.route(`**${chat}/sessions/${id}/skills`, async (route) => {
    const body = route.request().postDataJSON() as { pins: string[]; skill_discovery: boolean };
    patches.push(body);
    pins = body.pins.map(
      (pin) => pins.find((held) => held.id === pin) ?? { id: pin, status: null, chars: null },
    );
    await route.fulfill({
      json: { object: "chat_session", id, skill_discovery: body.skill_discovery, pins },
    });
  });

  await page.goto(`/chat/${id}`);

  // The assistant's reads are skill chips read for their message; the model's error is never shown.
  const loads = page.getByTestId("skill-load");
  await expect(loads).toHaveCount(3);
  await expect(loads.nth(0)).toHaveAttribute("data-state", "read");
  await expect(loads.nth(0).getByTestId("directive-chip")).toHaveText("read");
  await expect(loads.nth(0).getByTestId("skill-load-state")).toHaveText("Lue pour ce message");
  await expect(loads.nth(0).getByTestId("skill-load-live")).toHaveText(
    "Compétence read lue pour ce message",
  );
  // `tone` is pinned already: nothing to offer.
  await expect(loads.nth(1).getByTestId("skill-load-pin")).toHaveCount(0);
  await expect(loads.nth(2)).toHaveAttribute("data-state", "error");
  await expect(loads.nth(2).getByTestId("skill-load-state")).toHaveText("Lecture impossible");
  await expect(loads.nth(2).getByTestId("skill-load-pin")).toHaveCount(0);
  await expect(loads.nth(2)).not.toContainText("could not be read");

  // The pill counts what the next turn loads: `tone`, and `fresh` pending; `big` is left out.
  await expect(page.getByTestId("skill-pill-pinned")).toHaveText(/^\s*2 épinglées\s*$/);

  await openSkillsPicker(page);
  const popover = page.getByTestId("skills-picker-popover");
  const row = (pkg: string) => popover.getByTestId(`skill-pin-@acme/${pkg}`);
  const caption = (pkg: string) => popover.getByTestId(`skill-pin-state-@acme/${pkg}`);
  await expect(row("tone")).toBeChecked();
  await expect(caption("tone")).toHaveCount(0);
  await expect(row("big")).toBeChecked();
  await expect(caption("big")).toHaveText("Non chargée : budget de compétences dépassé");
  await expect(row("fresh")).toBeChecked();
  await expect(caption("fresh")).toHaveCount(0);
  await expect(row("read")).not.toBeChecked();
  await expect(popover.getByTestId("skills-budget")).toContainText(/4\s000 \/ 64\s000 caractères/);
  await expect(popover.getByTestId("skills-uncheck-hint")).toHaveText(
    "Décocher une compétence chargée la retire du contexte à partir du prochain message.",
  );
  await expect(popover.getByTestId("skills-pending-note")).toHaveText(
    "Les changements s'appliquent à partir du prochain message.",
  );
  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();

  // The chip's action pins the skill read: a PATCH of the full set.
  const pinned = page.waitForRequest((req) => req.method() === "PATCH");
  await loads.nth(0).getByTestId("skill-load-pin").click();
  expect((await pinned).postDataJSON()).toEqual({
    pins: ["@acme/big", "@acme/fresh", "@acme/read", "@acme/tone"],
    skill_discovery: true,
  });
  await expect(loads.nth(0).getByTestId("skill-load-pin")).toHaveCount(0);

  // Unchecking a pin sends the full set without it.
  await openSkillsPicker(page);
  const unpinned = page.waitForRequest((req) => req.method() === "PATCH");
  await row("tone").click();
  expect((await unpinned).postDataJSON()).toEqual({
    pins: ["@acme/big", "@acme/fresh", "@acme/read"],
    skill_discovery: true,
  });
  await expect(row("tone")).not.toBeChecked();
  expect(patches).toHaveLength(2);
});
