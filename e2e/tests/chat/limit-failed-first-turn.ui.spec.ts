// SPDX-License-Identifier: Apache-2.0

/**
 * A first turn that fails before the server created the conversation leaves nothing behind: lifting
 * the limit afterwards is still a change to the draft, not a refusal to surface. The PATCH it sends
 * finds no session (404), which is absorbed silently, and the retry carries the lifted limit.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";

test("lifting the limit after a failed first turn shows no error and the retry carries it", async ({
  authedPage: page,
  apiClient,
  browserCtx,
}) => {
  const chatRoute = `/orgs/${browserCtx.org.orgId}/chat`;
  const chat = `/api${chatRoute}`;
  const send = async (text: string) => {
    await page.getByRole("textbox", { name: "Message Appstrate…", exact: true }).fill(text);
    await page.keyboard.press("Enter");
  };
  const turns: { spaceId?: string; restricted?: boolean }[] = [];
  await page.route(`**${chat}`, (route) => {
    turns.push(route.request().postDataJSON());
    return route.fulfill({ status: 503, body: "" });
  });

  await page.goto("/chat");
  const chip = page.getByTestId("composer-limit-chip");
  await expect(chip).toBeVisible();

  await send("bonjour");
  await expect.poll(() => turns.length).toBe(1);
  expect(turns[0]!.restricted).toBe(true);

  // The conversation was never created: the PATCH finds no session, and that is no error.
  const patched = page.waitForResponse(
    (res) => res.request().method() === "PATCH" && res.url().includes(`${chat}/sessions/`),
  );
  await chip.getByRole("button").click();
  expect((await patched).status()).toBe(404);

  await send("encore");
  await expect.poll(() => turns.length).toBe(2);
  expect(turns[1]!.spaceId).toBeTruthy();
  expect(turns[1]!.restricted).toBeUndefined();

  await expect(chip).toHaveCount(0);
  await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

  const sessions = (await (await apiClient.get(`${chatRoute}/sessions`)).json()) as {
    data: unknown[];
  };
  expect(sessions.data).toEqual([]);
});
