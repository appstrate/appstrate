// SPDX-License-Identifier: Apache-2.0

/**
 * The skills of a conversation, from the browser: a skill the assistant read shows in its message
 * as the user's skill chip, whose action pins it, and the panel unpins. The states, captions and
 * budget text are covered by `skill-load.test.tsx` and `skills-picker.test.tsx`; here the session
 * detail, its skills PATCH and the commands are mocked, so the clicks are checked without a model.
 */

import type { Page } from "@playwright/test";
import type { components, operations } from "../../../apps/web/src/api/schema.d.ts";
import { test, expect } from "../../fixtures/browser.fixture.ts";

// Typed from the generated API types: a contract change breaks the typecheck, not the mock.
type SessionDetail = operations["getChatSession"]["responses"][200]["content"]["application/json"];
type Pin = components["schemas"]["ChatSession"]["pins"][number];

const skill = (name: string, bytes: number) => ({
  id: `@acme/${name}`,
  name,
  description: name,
  version: "1.0.0",
  bytes,
});
const commands: components["schemas"]["ChatCommands"] = {
  skills: [skill("read", 2000), skill("fresh", 3000), skill("tone", 1000)],
  agents: [],
};

async function openSkillsPicker(page: Page) {
  await page.getByTestId("composer-settings-trigger").click();
  await page.getByRole("menuitem", { name: /Compétences|Skills/ }).click();
}

test("a skill the assistant read is pinned from its chip, and unpinned from the panel", async ({
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
    { id: "@acme/fresh", status: null, chars: null },
    { id: "@acme/tone", status: "injected", chars: 1000 },
  ];
  const uri = `skill://${spaceId}/acme/read/read/SKILL.md`;
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
              {
                type: "tool-read_resource",
                toolCallId: "call_read",
                state: "output-available",
                input: { uri },
                output: { content: [{ type: "text", text: "---\nname: read\n---\nBody" }] },
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

  // The assistant's read is a skill chip.
  const load = page.getByTestId("skill-load");
  await expect(load.getByTestId("directive-chip")).toHaveText("read");

  // The pill counts what the next turn loads: `tone`, and `fresh` pending.
  await expect(page.getByTestId("skill-pill-pinned")).toHaveText(/^\s*2 épinglées\s*$/);

  // The chip's action pins the skill read: a PATCH of the full set.
  const pinned = page.waitForRequest((req) => req.method() === "PATCH");
  await load.getByTestId("skill-load-pin").click();
  expect((await pinned).postDataJSON()).toEqual({
    pins: ["@acme/fresh", "@acme/read", "@acme/tone"],
    skill_discovery: true,
  });
  await expect(load.getByTestId("skill-load-pin")).toHaveCount(0);

  // Unchecking a pin sends the full set without it.
  await openSkillsPicker(page);
  const row = (pkg: string) =>
    page.getByTestId("skills-picker-popover").getByTestId(`skill-pin-@acme/${pkg}`);
  const unpinned = page.waitForRequest((req) => req.method() === "PATCH");
  await row("tone").click();
  expect((await unpinned).postDataJSON()).toEqual({
    pins: ["@acme/fresh", "@acme/read"],
    skill_discovery: true,
  });
  await expect(row("tone")).not.toBeChecked();
  expect(patches).toHaveLength(2);
  // A detail refetch may still be in flight through the mock as the page closes.
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
