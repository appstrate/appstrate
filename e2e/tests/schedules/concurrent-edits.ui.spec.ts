// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createAgent, createSchedule } from "../../helpers/seed.ts";

test("two schedule editors can review and retry a stale change", async ({
  authedPage: first,
  browserCtx,
  apiClient,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  await createAgent(apiClient, scope, "scheduled");
  const { id } = await createSchedule(apiClient, scope, "scheduled");
  const path = `/schedules/${id}?scheduleSettings=general#settings`;
  const second = await first.context().newPage();
  const input = (page: typeof first) =>
    page.getByRole("textbox", { name: /Nom \(optionnel\)|Name \(optional\)/ });
  const save = (page: typeof first) => page.getByRole("button", { name: /^(Enregistrer|Save)$/ });
  const submit = async (page: typeof first) => {
    const updated = page.waitForResponse(
      (res) =>
        res.url().split("?")[0]?.endsWith(`/schedules/${id}`) && res.request().method() === "PATCH",
    );
    await save(page).click();
    return updated;
  };
  await Promise.all([first.goto(path), second.goto(path)]);
  await input(first).fill("First editor");
  await input(second).fill("Second editor");
  const saved = await submit(second);
  expect(saved.ok()).toBe(true);
  const stale = await submit(first);
  expect(stale.status()).toBe(412);
  expect(await stale.request().headerValue("if-match")).toBe(
    await saved.request().headerValue("if-match"),
  );
  await expect(input(first)).toHaveValue("First editor");
  await first.getByRole("button", { name: /Revoir mes modifications|Review my edits/ }).click();
  const retried = await submit(first);
  expect(retried.ok()).toBe(true);
  expect(await retried.request().headerValue("if-match")).not.toBe(
    await stale.request().headerValue("if-match"),
  );
  await second.reload();
  await expect(input(second)).toHaveValue("First editor");
});
