// SPDX-License-Identifier: Apache-2.0

/**
 * Attachment and conversation destinations from « Tous les espaces ». A conversation with no origin space has
 * nothing to confine it to, so « Limiter à un espace » asks which space among those the chat acts
 * in; the space picked becomes its origin, in one `PATCH { spaceId, restricted: true }`. From
 * then on it is listed under that space's filter and no other's (before, holding no space, it
 * belonged to every filter).
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

    await page.getByRole("button", { name: "Joindre des fichiers", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: beta.name }).click();
    await (
      await choosing
    ).setFiles([
      { name: "beta.txt", mimeType: "text/plain", buffer: Buffer.from("Beta") },
      {
        name: "beta.png",
        mimeType: "image/png",
        buffer: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aNJkAAAAASUVORK5CYII=",
          "base64",
        ),
      },
    ]);
    await expect(page.getByText("beta.txt", { exact: true })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Aperçu de beta.png", exact: true }),
    ).toBeVisible();

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
    // Both attachments were picked in Beta. The rejected send keeps the draft and names
    // the space on each attachment, including the image thumbnail.
    const message = page.getByRole("textbox", { name: "Message Appstrate…", exact: true });
    await message.fill("Voici les fichiers.");
    await page.getByRole("button", { name: "Envoyer", exact: true }).click();
    for (const name of ["beta.txt", "beta.png"]) {
      await expect(page.getByRole("alert").filter({ hasText: name })).toContainText(
        `Ce fichier est joint dans ${beta.name}`,
      );
    }
    await expect(message).toHaveValue("Voici les fichiers.");
    const remove = page.getByRole("button", { name: "Retirer la pièce jointe" });
    await remove.first().click();
    await remove.first().click();
    await expect(page.getByRole("alert").filter({ hasText: beta.name })).toHaveCount(0);
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

test("the overview attach button stages the file in the chosen space", async ({
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const { orgId, defaultSpaceId } = browserCtx.org;
  const destination = await createSpace(orgOnlyClient, `Atelier ${Date.now()}`);
  const context = await createOverviewContext(browser, browserCtx.auth, orgId, defaultSpaceId);
  const page = await context.newPage();
  try {
    // Uploads reach the real server. The turn itself does not need a provider.
    await page.route(`**/api/orgs/${orgId}/chat`, (route) => route.fulfill({ status: 503 }));
    await page.goto("/chat");
    await page.getByRole("button", { name: "Joindre des fichiers", exact: true }).click();
    const choosing = page.waitForEvent("filechooser");
    await page.getByRole("menuitem", { name: destination.name }).click();
    await (
      await choosing
    ).setFiles({
      name: "atelier.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Atelier"),
    });
    await expect(page.getByText("atelier.txt", { exact: true })).toBeVisible();
    const upload = page.waitForResponse(
      (res) => res.request().method() === "POST" && new URL(res.url()).pathname === "/api/uploads",
    );
    await page
      .getByRole("textbox", { name: "Message Appstrate…", exact: true })
      .fill("Voici le fichier.");
    await page.getByRole("button", { name: "Envoyer", exact: true }).click();
    const response = await upload;
    expect(await response.request().headerValue("X-Space-Id")).toBe(destination.id);
    expect(response.ok()).toBe(true);
  } finally {
    await context.close();
  }
});
