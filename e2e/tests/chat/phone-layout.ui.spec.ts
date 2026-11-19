// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";

test.use({ hasTouch: true });

test("chat fields stay legible in both orientations and the search sheet fits the visual viewport", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const sessions = `/orgs/${browserCtx.org.orgId}/chat/sessions`;
  const created = await orgOnlyClient.post(sessions, { title: "Mobile layout" });
  expect(created.status()).toBe(201);
  const { id } = await created.json();
  const other = await orgOnlyClient.post(sessions, { title: "Search destination" });
  expect(other.status()).toBe(201);
  const destination = await other.json();
  // Exercise the real Markdown renderer with a saved answer, without a model call.
  await page.route(`**/api${sessions}/${id}`, async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: {
        ...(await response.json()),
        messages: [
          {
            id: "answer",
            content: { role: "assistant", parts: [{ type: "text", text: "```ts\n42\n```" }] },
          },
        ],
      },
    });
  });
  await page.setViewportSize({ width: 844, height: 390 });
  await page.goto(`/chat/${id}`);
  const composer = page.getByRole("textbox", { name: "Message Appstrate…", exact: true });
  const search = page.getByRole("searchbox");
  const code = page.locator("pre > code");
  await expect(composer).toHaveCSS("font-size", "16px");
  await expect(search).toHaveCSS("font-size", "16px");
  await expect(code).toHaveCSS("font-size", "12px");
  const send = page.getByRole("button", { name: "Envoyer", exact: true });
  const fieldBox = await composer.boundingBox();
  const sendBox = await send.boundingBox();
  if (!fieldBox || !sendBox) throw new Error("Composer controls are missing");
  expect(sendBox.y).toBeGreaterThanOrEqual(fieldBox.y);
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(code).toHaveCSS("font-size", "14px");
  await page.locator('header [data-sidebar="trigger"]:visible').click();
  const sheet = page.getByRole("dialog");
  await search.fill("Search destination");
  // Desktop Chromium has no on-screen keyboard. Feed a resize through the mounted hook.
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Object.defineProperties(viewport, {
      height: { configurable: true, value: 377 },
      offsetTop: { configurable: true, value: 32 },
    });
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect(sheet).toHaveCSS("top", "32px");
  await expect(sheet).toHaveCSS("height", "377px");
  await expect(search).toHaveCSS("font-size", "16px");
  const result = sheet.getByRole("button", { name: /^Search destination/ });
  // Leave enough of the results scroller visible for a complete row, even with the nav footer.
  const list = sheet.getByRole("list").filter({ hasText: "Search destination" }).last();
  await expect.poll(() => list.evaluate((el) => el.clientHeight)).toBeGreaterThanOrEqual(48);
  await result.click();
  await expect(page).toHaveURL(new RegExp(`/chat/${destination.id}$`));
  await expect(sheet).toBeHidden();
  await page.evaluate(() => {
    const viewport = window.visualViewport!;
    Reflect.deleteProperty(viewport, "height");
    Reflect.deleteProperty(viewport, "offsetTop");
    viewport.dispatchEvent(new Event("resize"));
  });
  await expect
    .poll(() =>
      page
        .locator("html")
        .evaluate((root) => root.style.getPropertyValue("--keyboard-viewport-height")),
    )
    .toBe("");
});

test("a fresh phone composer keeps attach, input and send on one line until the first interaction", async ({
  authedPage: page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/chat");
  const input = page.getByRole("textbox", { name: "Message Appstrate…", exact: true });
  const attach = page.getByRole("button", { name: /^Joindre des fichiers/ });
  const send = page.getByRole("button", { name: "Envoyer", exact: true });
  const grid = page.locator(".chat-composer-grid").filter({ has: input });
  await expect(input).toBeVisible();
  await expect(input).not.toBeFocused();
  await expect(grid).toHaveAttribute("data-rest", "");
  const row = await Promise.all([attach, input, send].map((control) => control.boundingBox()));
  if (row.some((box) => !box)) throw new Error("Missing resting controls");
  const [a, b, c] = row.map((box) => box!);
  expect(Math.max(a.y, b.y, c.y)).toBeLessThan(
    Math.min(a.y + a.height, b.y + b.height, c.y + c.height),
  );
  expect(a.x + a.width).toBeLessThanOrEqual(b.x + 1);
  expect(b.x + b.width).toBeLessThanOrEqual(c.x + 1);
  const choosing = page.waitForEvent("filechooser");
  await attach.tap();
  await (await choosing).setFiles([]);
  await expect(grid).not.toHaveAttribute("data-rest", "");
  await input.tap();
  await expect(input).toBeFocused();
  await input.fill("Bonjour");
  await expect(send).toBeEnabled();
});
