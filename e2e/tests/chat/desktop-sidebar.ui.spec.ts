// SPDX-License-Identifier: Apache-2.0

import type { Locator } from "@playwright/test";
import { expect, test } from "../../fixtures/browser.fixture.ts";

test.use({ viewport: { width: 1440, height: 900 } });

const widthOf = async (locator: Locator) => Math.round((await locator.boundingBox())!.width);

test("the chat sidebar resizes by drag, keys and double-click, and keeps its width", async ({
  authedPage: page,
}) => {
  await page.goto("/chat");
  const sidebar = page.locator("#app-sidebar");
  const handle = page.getByRole("separator", { name: "Redimensionner le menu latéral" });
  await expect(handle).toHaveAttribute("aria-valuenow", "256");
  await expect.poll(() => widthOf(sidebar)).toBe(256);

  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 100, y, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => widthOf(sidebar)).toBe(356);
  await expect(handle).toHaveAttribute("aria-valuenow", "356");

  await page.reload();
  await expect.poll(() => widthOf(sidebar)).toBe(356);

  await handle.dblclick();
  await expect.poll(() => widthOf(sidebar)).toBe(256);
  await expect(handle).toHaveAttribute("aria-valuenow", "256");

  await handle.focus();
  await page.keyboard.press("ArrowRight");
  await expect(handle).toHaveAttribute("aria-valuenow", "280");
  await page.keyboard.press("Home");
  await expect(handle).toHaveAttribute("aria-valuenow", "224");
  // min(480, 30% of the 1440 px window).
  await page.keyboard.press("End");
  await expect(handle).toHaveAttribute("aria-valuenow", "432");
  await expect.poll(() => widthOf(sidebar)).toBe(432);
});

test("a date group folds from its heading, stays folded, and keeps the open conversation", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const sessions = `/orgs/${browserCtx.org.orgId}/chat/sessions`;
  const create = async (title: string) => {
    const response = await orgOnlyClient.post(sessions, { title });
    expect(response.status()).toBe(201);
    return ((await response.json()) as { id: string }).id;
  };
  const first = await create("Pli ouvert");
  await create("Pli caché");

  await page.goto("/chat");
  const sidebar = page.locator("#app-sidebar");
  const today = sidebar.getByRole("button", { name: "Aujourd’hui", exact: true });
  const open = sidebar.getByRole("button", { name: /^Pli ouvert/ });
  const hidden = sidebar.getByRole("button", { name: /^Pli caché/ });
  await expect(today).toHaveAttribute("aria-expanded", "true");
  await expect(open).toBeVisible();

  await today.click();
  await expect(today).toHaveAttribute("aria-expanded", "false");
  await expect(open).toHaveCount(0);
  await expect(hidden).toHaveCount(0);

  await page.reload();
  await expect(today).toHaveAttribute("aria-expanded", "false");
  await expect(hidden).toHaveCount(0);

  await today.click();
  await expect(today).toHaveAttribute("aria-expanded", "true");
  await expect(open).toBeVisible();
  await expect(hidden).toBeVisible();

  // Folded over the open conversation: its row alone stays under the heading.
  await today.click();
  await page.goto(`/chat/${first}`);
  await expect(today).toHaveAttribute("aria-expanded", "false");
  await expect(open).toBeVisible();
  await expect(hidden).toHaveCount(0);
});
