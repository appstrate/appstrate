// SPDX-License-Identifier: Apache-2.0

/**
 * A conversation belongs to the organization and its author, not to a space: its origin space
 * is where it started, a limit can confine it there, and deleting that space detaches it
 * instead of taking the conversation along. No turn is generated: the conversation is
 * created through the API (the model is not the subject), and the browser opens it.
 */

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSpace } from "../../helpers/seed.ts";
import { Sidebar } from "../../pages/sidebar.ts";

interface SessionDto {
  id: string;
  spaceId: string | null;
  restricted: boolean;
}

test("a limited conversation lifts its limit, survives a space switch and the deletion of its origin space", async ({
  authedPage: page,
  orgOnlyClient,
  browserCtx,
}) => {
  const origin = await createSpace(orgOnlyClient, `Origin ${Date.now()}`);
  const elsewhere = await createSpace(orgOnlyClient, `Elsewhere ${Date.now()}`);
  const chatRoute = `/orgs/${browserCtx.org.orgId}/chat`;

  // Started in `origin`, limited to it.
  const created = await orgOnlyClient.post(`${chatRoute}/sessions`, {
    title: "Across spaces",
    spaceId: origin.id,
    restricted: true,
  });
  expect(created.status()).toBe(201);
  const session = (await created.json()) as SessionDto;
  expect(session.spaceId).toBe(origin.id);
  expect(session.restricted).toBe(true);

  const read = async (): Promise<SessionDto> =>
    (await (await orgOnlyClient.get(`${chatRoute}/sessions/${session.id}`)).json()) as SessionDto;

  // The composer says the conversation is limited.
  await page.goto(`/chat/${session.id}`);
  const chip = page.getByTestId("composer-limit-chip");
  await expect(chip).toBeVisible();

  // Lifting the limit is one PATCH carrying `restricted: false`.
  const lifted = page.waitForRequest(
    (req) => req.method() === "PATCH" && req.url().endsWith(`${chatRoute}/sessions/${session.id}`),
  );
  await chip.getByRole("button").click();
  expect(((await lifted).postDataJSON() as { restricted?: boolean }).restricted).toBe(false);
  await expect(chip).toHaveCount(0);
  await expect.poll(async () => (await read()).restricted).toBe(false);

  // The conversation is not the space's: it opens whichever space is selected.
  await new Sidebar(page).switchSpace(elsewhere.name);
  await page.goto(`/chat/${session.id}`);
  await expect(page).toHaveURL(new RegExp(`/chat/${session.id}$`));
  await expect(chip).toHaveCount(0);
  expect((await read()).spaceId).toBe(origin.id);

  // Deleting the origin space detaches the conversation (no origin, no limit), it does not delete it.
  const deleted = await orgOnlyClient.delete(`/spaces/${origin.id}`);
  expect(deleted.status()).toBe(204);
  const listed = (await (await orgOnlyClient.get(`${chatRoute}/sessions`)).json()) as {
    data: SessionDto[];
  };
  const survivor = listed.data.find((row) => row.id === session.id);
  expect(survivor).toBeDefined();
  expect(survivor?.spaceId).toBeNull();
  expect(survivor?.restricted).toBe(false);
});
