// SPDX-License-Identifier: Apache-2.0

/**
 * Limiting a conversation from « Tous les espaces ». A conversation with no origin space has
 * nothing to confine it to, so « Limiter à un espace » asks which space among those the chat acts
 * in; the space picked becomes its origin, in one `PATCH { spaceId, restricted: true }`. From
 * then on it is listed under that space's filter and no other's (before, holding no space, it
 * belonged to every filter). No turn is generated: the conversation is created through the API.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSpace } from "../../helpers/seed.ts";
import { createOverviewContext } from "../../helpers/overview.ts";

interface SessionDto {
  id: string;
  spaceId: string | null;
  restricted: boolean;
}

test("a conversation with no origin is limited to the space picked from « Tous les espaces »", async ({
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const alpha = await createSpace(orgOnlyClient, `Alpha ${Date.now()}`);
  const beta = await createSpace(orgOnlyClient, `Beta ${Date.now()}`);
  const chatRoute = `/orgs/${orgId}/chat`;

  const created = await orgOnlyClient.post(`${chatRoute}/sessions`, { title: "Sans origine" });
  expect(created.status()).toBe(201);
  const session = (await created.json()) as SessionDto;
  expect(session.spaceId).toBeNull();

  const listedUnder = async (spaceId: string): Promise<string[]> => {
    const res = await orgOnlyClient.get(`${chatRoute}/sessions?spaceId=${spaceId}`);
    expect(res.status()).toBe(200);
    return ((await res.json()) as { data: SessionDto[] }).data.map((row) => row.id);
  };
  // Holding no space yet, it belongs to every filter.
  expect(await listedUnder(alpha.id)).toContain(session.id);
  expect(await listedUnder(beta.id)).toContain(session.id);

  const context = await createOverviewContext(
    browser,
    browserCtx.auth,
    orgId,
    browserCtx.org.defaultSpaceId,
  );
  const page = await context.newPage();
  try {
    await page.goto(`/chat/${session.id}`);
    await expect(page.locator("[data-trail]")).toContainText("Sans origine");
    const chip = page.getByTestId("composer-limit-chip");
    await expect(chip).toHaveCount(0);

    const attach = page.getByRole("button", { name: "Joindre des fichiers", exact: true });
    await attach.click();
    const files = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: beta.name }).click();
    await (
      await files
    ).setFiles({
      name: "beta.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Beta"),
    });
    await expect(page.getByText("beta.txt", { exact: true })).toBeVisible();

    // Settings › « Limiter à un espace » › the acting spaces.
    await page.getByTestId("composer-settings-trigger").click();
    const limit = page.getByTestId("composer-limit-item");
    await expect(limit).toHaveText(/Limiter à un espace/);
    await limit.click();
    const choices = page.getByRole("menu", { name: "Limiter à un espace", exact: true });
    await expect(choices).toBeVisible();
    await expect(choices.getByText("Limiter à…", { exact: true })).toBeVisible();
    const entries = choices.getByRole("menuitem");
    await expect(entries.filter({ hasText: alpha.name })).toHaveCount(1);
    await expect(entries.filter({ hasText: beta.name })).toHaveCount(1);

    const patched = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        response.url().endsWith(`/api${chatRoute}/sessions/${session.id}`),
    );
    await entries.filter({ hasText: alpha.name }).click();
    const response = await patched;
    expect(response.request().postDataJSON()).toEqual({ spaceId: alpha.id, restricted: true });
    expect(response.status()).toBe(204);
    await expect(chip).toBeVisible();
    const direct = page.waitForEvent("filechooser");
    await page.getByRole("button", { name: `Joindre des fichiers dans ${alpha.name}` }).click();
    await (
      await direct
    ).setFiles({
      name: "alpha.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Alpha"),
    });
    await expect(page.getByText("alpha.txt", { exact: true })).toBeVisible();
  } finally {
    await context.close();
  }

  // Alpha is now its origin: listed under Alpha's filter, no longer under Beta's.
  expect(await listedUnder(alpha.id)).toContain(session.id);
  expect(await listedUnder(beta.id)).not.toContain(session.id);
});
