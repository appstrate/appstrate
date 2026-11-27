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
  // Text size follows the pointer, not the width: on touch a code block is 14 px in both orientations.
  await expect(code).toHaveCSS("font-size", "14px");
  const send = page.getByRole("button", { name: "Envoyer", exact: true });
  const fieldBox = await composer.boundingBox();
  const sendBox = await send.boundingBox();
  if (!fieldBox || !sendBox) throw new Error("Composer controls are missing");
  expect(sendBox.y).toBeGreaterThanOrEqual(fieldBox.y);
  expect(sendBox.y + sendBox.height).toBeLessThanOrEqual(fieldBox.y + fieldBox.height);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(code).toHaveCSS("font-size", "14px");
  await page.getByTestId("sidebar-opener").click();
  const sheet = page.getByRole("dialog");
  // Below md the search is a magnifier that unfolds the field.
  await page.getByTestId("chat-search-toggle").click();
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

test('a phone composer is one line for good: the "+", the input and send', async ({
  authedPage: page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto("/chat");
  const input = page.getByRole("textbox", { name: "Message Appstrate…", exact: true });
  const plus = page.getByTestId("composer-plus");
  const send = page.getByRole("button", { name: "Envoyer", exact: true });
  await expect(input).toBeVisible();
  await expect(input).not.toBeFocused();
  const line = async () => {
    const [left, field, right] = await Promise.all([
      plus.boundingBox(),
      input.boundingBox(),
      send.boundingBox(),
    ]);
    if (!left || !field || !right) throw new Error("Missing composer controls");
    expect(Math.max(left.y, field.y, right.y)).toBeLessThan(
      Math.min(left.y + left.height, field.y + field.height, right.y + right.height),
    );
    expect(left.x + left.width).toBeLessThanOrEqual(field.x + 1);
    expect(field.x + field.width).toBeLessThanOrEqual(right.x + 1);
  };
  await line();
  // The tools are behind the "+", and the line does not change once the composer is used.
  await plus.tap();
  await expect(page.getByRole("button", { name: /^Joindre des fichiers/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await input.tap();
  await expect(input).toBeFocused();
  await input.fill("Bonjour");
  await expect(send).toBeEnabled();
  await line();
});

test("the desktop's settings button opens the panel the phone's \"+\" opens, with the same rows", async ({
  authedPage: page,
}) => {
  const rows = async () => {
    const panel = page.getByRole("dialog", { name: "Outils et réglages" });
    await expect(panel).toBeVisible();
    await expect(panel.getByTestId("composer-panel-skills")).toBeVisible();
    await expect(panel.getByTestId("composer-limit-item")).toBeVisible();
    // Escape closes the top level.
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  };
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/chat");
  await page.getByTestId("composer-settings-trigger").click();
  await rows();

  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId("composer-plus").tap();
  await rows();
});
