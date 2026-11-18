// SPDX-License-Identifier: Apache-2.0

/**
 * A file dropped into the chat from « Tous les espaces », where the member acts in several team
 * spaces, is staged in their personal space (« Mon espace »): no space question, and the file
 * is listed there once the turn has materialized it. The model is a local OpenAI-compatible stub.
 */

import type { Locator, Page } from "@playwright/test";
import { test, expect } from "../../fixtures/browser.fixture.ts";
import { pickModel, withLocalChatModel } from "../../helpers/chat-model.ts";
import { createSpace } from "../../helpers/seed.ts";
import { createOverviewContext } from "../../helpers/overview.ts";

interface SpaceDto {
  id: string;
  personal: boolean;
  access: "member" | "none";
}

/** A real drop on the thread: a DataTransfer carrying the file, dispatched on the dropzone. */
async function dropFile(page: Page, dropzone: Locator, name: string): Promise<void> {
  const transfer = await page.evaluateHandle((fileName) => {
    const data = new DataTransfer();
    data.items.add(new File(["Bonjour"], fileName, { type: "text/plain" }));
    return data;
  }, name);
  await dropzone.dispatchEvent("dragenter", { dataTransfer: transfer });
  await dropzone.dispatchEvent("dragover", { dataTransfer: transfer });
  await dropzone.dispatchEvent("drop", { dataTransfer: transfer });
}

test("a drop in « Tous les espaces » stages the file in the personal space", async ({
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  test.slow();
  const { orgId, defaultSpaceId } = browserCtx.org;
  await createSpace(orgOnlyClient, `Alpha ${Date.now()}`);
  await createSpace(orgOnlyClient, `Beta ${Date.now()}`);
  const spaces = (await (await orgOnlyClient.get("/spaces")).json()) as { data: SpaceDto[] };
  const personal = spaces.data.find((space) => space.personal && space.access === "member");
  expect(personal).toBeDefined();

  const answer = "Fichier reçu.";
  const context = await createOverviewContext(browser, browserCtx.auth, orgId, defaultSpaceId);
  try {
    await withLocalChatModel(
      apiClient,
      { modelId: "local-chat-text", input: ["text"], reply: () => answer },
      async ({ modelId }) => {
        const page = await context.newPage();
        await page.goto("/chat");
        await pickModel(page, modelId);
        const message = page.getByPlaceholder("Message Appstrate…");
        await expect(message).toBeVisible();
        // The attach button is usable at once: no space to choose.
        await expect(
          page.getByRole("button", { name: "Joindre des fichiers", exact: true }),
        ).toBeEnabled();

        await dropFile(page, page.getByTestId("chat-dropzone"), "depose.txt");
        await expect(page.getByText("depose.txt", { exact: true })).toBeVisible();

        const upload = page.waitForResponse(
          (res) =>
            res.request().method() === "POST" && new URL(res.url()).pathname === "/api/uploads",
        );
        await message.fill("Voici le fichier.");
        await page.getByRole("button", { name: "Envoyer", exact: true }).click();
        const response = await upload;
        expect(response.ok()).toBe(true);
        expect(await response.request().headerValue("X-Space-Id")).toBe(personal!.id);
        await expect(page.getByText(answer, { exact: true })).toBeVisible();
        await expect(page.getByText("depose.txt", { exact: true })).toBeVisible();

        // The turn materialized the upload: the file is listed in « Mon espace ».
        await expect
          .poll(async () => {
            const listed = await apiClient.withSpace(personal!.id).get("/files");
            return JSON.stringify(await listed.json());
          })
          .toContain("depose.txt");
      },
    );
  } finally {
    await context.close();
  }
});

test("a drop under a role preview says why nothing is attached", async ({
  browser,
  browserCtx,
}) => {
  const { orgId, defaultSpaceId } = browserCtx.org;
  const context = await createOverviewContext(browser, browserCtx.auth, orgId, defaultSpaceId);
  // A previewed role holds no personal space: attaching is unavailable for good.
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [
    "appstrate_view_as",
    JSON.stringify({ orgId, orgRole: "member", space: null }),
  ] as const);
  try {
    const page = await context.newPage();
    await page.goto("/chat");
    await expect(page.getByPlaceholder("Message Appstrate…")).toBeVisible();
    await dropFile(page, page.getByTestId("chat-dropzone"), "depose.txt");
    await expect(page.getByText(/Aperçu d’un rôle/)).toBeVisible();
  } finally {
    await context.close();
  }
});
