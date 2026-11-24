// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createSpace } from "../../helpers/seed.ts";
import { createOverviewContext } from "../../helpers/overview.ts";
import { pickModel, withLocalChatModel } from "../../helpers/chat-model.ts";

test("organization reads need no choice and a selected team is recorded on the resumed turn", async ({
  browser,
  browserCtx,
  orgOnlyClient,
  apiClient,
}) => {
  test.setTimeout(90_000);
  const { orgId, defaultSpaceId } = browserCtx.org;
  const team = await createSpace(orgOnlyClient, "Équipe de recette");
  const context = await createOverviewContext(browser, browserCtx.auth, orgId, defaultSpaceId);
  const page = await context.newPage();
  const modelId = "space-choice-e2e";
  let operation = "listModels";
  let answeringChoice = false;
  let userPromptAtProvider: unknown;
  try {
    await withLocalChatModel(
      apiClient,
      {
        modelId,
        input: ["text"],
        reply: ({ messages }) => {
          const last = messages.at(-1);
          if (last?.role !== "tool") {
            if (answeringChoice && last?.role === "user") userPromptAtProvider = last.content;
            // The fixture deliberately supplies no space, even after the user picks one.
            return { name: "invoke_operation", arguments: { operation_id: operation } };
          }
          const receipt = JSON.stringify(last.content);
          if (operation === "listModels" && receipt.includes(modelId))
            return "Modèles disponibles.";
          if (
            operation === "listAgents" &&
            receipt.includes(team.id) &&
            !receipt.includes("missing_argument")
          )
            return "Agents de l’équipe affichés.";
          return "En attente du choix.";
        },
      },
      async () => {
        await page.goto("/chat");
        await pickModel(page, modelId);
        const composer = page.getByRole("textbox", { name: "Message Appstrate…", exact: true });
        const send = page.getByRole("button", { name: "Envoyer", exact: true });
        await composer.fill("Liste les modèles.");
        await send.click();
        await expect(page.getByText("Modèles disponibles.", { exact: true })).toBeVisible();
        const picker = page.getByRole("group", { name: "Choisissez un espace", exact: true });
        await expect(picker).toHaveCount(0);
        const sessionId = new URL(page.url()).pathname.split("/").at(-1);
        const touched = async () => {
          const res = await orgOnlyClient.get(`/orgs/${orgId}/chat/sessions/${sessionId}`);
          expect(res.status()).toBe(200);
          return ((await res.json()) as { space_ids: string[] }).space_ids;
        };
        expect(await touched()).toEqual([]);
        operation = "listAgents";
        await composer.fill("Liste les agents.");
        await send.click();
        const chooseTeam = picker.getByRole("button", { name: team.name, exact: true });
        await expect(chooseTeam).toBeVisible();
        expect(await touched()).toEqual([]);
        await page.reload();
        await expect(chooseTeam).toBeVisible();
        // The session may be limited from another tab while this question is pending.
        // A newly created space was never offered on the original turn.
        const later = await createSpace(orgOnlyClient, "Autre espace");
        const sessionPath = `/orgs/${orgId}/chat/sessions/${sessionId}`;
        const limit = await orgOnlyClient.patch(sessionPath, {
          spaceId: later.id,
          restricted: true,
        });
        expect(limit.status()).toBe(204);
        await page.reload();
        await expect(
          page
            .getByRole("status")
            .filter({ hasText: "Envoyez un nouveau message pour la reprendre." }),
        ).toBeVisible();
        await expect(picker).toHaveCount(0);
        const lift = await orgOnlyClient.patch(sessionPath, { restricted: false });
        expect(lift.status()).toBe(204);
        await page.reload();
        await expect(chooseTeam).toBeVisible();
        answeringChoice = true;
        await chooseTeam.click();
        await expect(page.getByText("Agents de l’équipe affichés.", { exact: true })).toBeVisible();
        const reply = "Utilise l’espace sélectionné pour cette demande.";
        await expect(page.getByText(reply, { exact: true })).toBeVisible();
        expect(JSON.stringify(userPromptAtProvider)).toContain(reply);
        expect(JSON.stringify(userPromptAtProvider)).not.toContain(team.name);
        await expect.poll(touched).toEqual([later.id, team.id]);
        await expect(picker).toHaveCount(0);
        await page.reload();
        await expect(page.getByText("Agents de l’équipe affichés.", { exact: true })).toBeVisible();
      },
    );
  } finally {
    await context.close();
  }
});
