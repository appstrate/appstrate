// SPDX-License-Identifier: Apache-2.0

import { test, expect } from "../../fixtures/browser.fixture.ts";
import { createIntegration } from "../../helpers/seed.ts";

test("a configurer releases the default connection after the last auth has been retired", async ({
  apiClient,
  browserCtx,
  authedPage: page,
}) => {
  const { orgSlug, defaultSpaceId } = browserCtx.org;
  const { id } = await createIntegration(apiClient, `@${orgSlug}`, "accounts");
  const integration = `/integrations/${id}`;
  const connected = await apiClient.post(`${integration}/auths/api/connect/fields`, {
    credentials: { api_key: "test-account" },
  });
  expect(connected.ok(), await connected.text()).toBe(true);
  const connection = await connected.json();
  const share = `/me/connections/${connection.id}/shares/${defaultSpaceId}`;
  expect((await apiClient.put(share)).status()).toBe(204);
  const set = await apiClient.put(`${integration}/default`, {
    connection_ids: [connection.id],
    enforce: true,
  });
  expect(set.ok(), await set.text()).toBe(true);

  const packagePath = `/packages/integrations/${id}`;
  const detail = await apiClient.get(packagePath);
  const { manifest } = await detail.json();
  delete manifest.auths;
  const edited = await apiClient.patch(
    packagePath,
    {
      manifest: {
        ...manifest,
        schema_version: "0.3",
        source: {
          kind: "remote",
          remote: { url: "https://example.invalid/mcp", transport: "streamable-http" },
        },
      },
    },
    { "If-Match": detail.headers()["etag"]! },
  );
  expect(edited.ok(), await edited.text()).toBe(true);
  const published = await apiClient.post(`${packagePath}/versions`, { version: "2.0.0" });
  expect(published.ok(), await published.text()).toBe(true);
  const locked = await apiClient.delete(share);
  expect(locked.status()).toBe(409);
  expect((await locked.json()).code).toBe("connection_pinned");

  await page.goto(`${integration}?integrationSettings=default-connection#settings`);
  const section = page.getByTestId("default-connection-settings");
  await expect(section.getByText("Cette intégration fonctionne sans compte.")).toBeVisible();
  await section.getByRole("combobox", { name: "Utilisation des connexions" }).click();
  await page.getByRole("option", { name: "Connexion choisie par l’utilisateur" }).click();
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "DELETE" &&
      new URL(response.url()).pathname === `/api${integration}/default`,
  );
  await page.getByRole("button", { name: "Enregistrer", exact: true }).click();
  expect((await saved).status()).toBe(200);
  expect((await apiClient.delete(share)).status()).toBe(204);
});
