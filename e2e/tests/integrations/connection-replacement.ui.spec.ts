// SPDX-License-Identifier: Apache-2.0

import { createServer } from "node:http";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createApiClient } from "../../helpers/api-client.ts";
import { E2E_BASE_URL } from "../../helpers/base-url.ts";
import { registerUser } from "../../helpers/seed.ts";
import { apiIntegrationManifest } from "../../../apps/api/test/helpers/integration-manifests.ts";

test("an owner replaces an expired key in the agent picker when the space allows creation", async ({
  browser,
  request,
  apiClient: admin,
  browserCtx,
  orgOnlyClient,
}) => {
  test.slow();
  const { orgId, orgSlug, defaultSpaceId: spaceId } = browserCtx.org;
  const member = await registerUser(request, { name: "Connection owner" });
  const invite = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
    email: member.email,
    role: "member",
  });
  expect(invite.status(), await invite.text()).toBe(201);
  const { token } = await invite.json();
  const accepted = await request.post(`/invite/${token}/accept`, {
    headers: { Cookie: member.cookie, Origin: E2E_BASE_URL },
  });
  expect(accepted.status(), await accepted.text()).toBe(200);
  const actor = createApiClient(request, { cookie: member.cookie, orgId, spaceId });
  const upstream = createServer((_req, res) => {
    res.writeHead(401);
    res.end();
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const context = await createAuthedContext(browser, member, orgId, spaceId);
  try {
    const address = upstream.address();
    if (!address || typeof address === "string") throw new Error("Test server has no port");
    const origin = `http://127.0.0.1:${address.port}`;
    const integration = `@${orgSlug}/key-service`;
    const agent = `@${orgSlug}/report`;
    const base = `/integrations/${integration}`;
    const created = await admin.post("/packages/integrations", {
      publish: true,
      manifest: apiIntegrationManifest({
        name: integration,
        auths: {
          api: { type: "api_key", authorizedUris: [`${origin}/**`], credentialFields: ["api_key"] },
        },
        apiCall: { authKey: "api" },
      }),
    });
    expect(created.status(), await created.text()).toBe(201);
    const report = await admin.post("/packages/agents", {
      manifest: {
        name: agent,
        display_name: "Key service report",
        schema_version: "0.2",
        type: "agent",
        version: "1.0.0",
        dependencies: { integrations: { [integration]: "1.0.0" } },
        integrations_configuration: { [integration]: { required: true, tools: ["api_call"] } },
      },
      content: "Use the key service.",
    });
    expect(report.status(), await report.text()).toBe(201);
    for (const packageId of [integration, agent]) {
      const placement = await admin.post(`/spaces/${spaceId}/packages`, { packageId });
      expect(placement.ok(), await placement.text()).toBe(true);
    }
    const old = await actor.post(`${base}/auths/api/connect/fields`, {
      credentials: { api_key: "local-expired" },
    });
    expect(old.ok(), await old.text()).toBe(true);
    const { id: original, account_id: account } = await old.json();
    expect(account).toBe("default");
    const shared = await actor.put(`/me/connections/${original}/shares/${spaceId}`);
    expect(shared.status(), await shared.text()).toBe(204);
    const pin = `/me/integration-pins/${agent}/integrations/${integration}`;
    const pinned = await actor.put(pin, { connection_ids: [original] });
    expect(pinned.ok(), await pinned.text()).toBe(true);
    const key = await admin.post("/api-keys", {
      name: "Local credential check",
      scopes: ["credential-proxy:call"],
    });
    expect(key.status(), await key.text()).toBe(201);
    const { key: bearer } = await key.json();
    await expect
      .poll(
        async () => {
          const response = await request.get("/api/credential-proxy/proxy", {
            headers: {
              Authorization: `Bearer ${bearer}`,
              "X-Org-Id": orgId,
              "X-Space-Id": spaceId,
              "X-Integration-Id": integration,
              "X-Connection-Id": original,
              "X-Target": origin + "/account",
              "X-Session-Id": crypto.randomUUID(),
            },
          });
          expect([401, 409], await response.text()).toContain(response.status());
          return (
            response.headers()["x-appstrate-credential-status"]?.startsWith("needs_reconnection") ||
            response.status() === 409
          );
        },
        { intervals: [20, 50, 100] },
      )
      .toBe(true);
    const page = await context.newPage();
    const agentSettings = `/agents/${agent}?agentSettings=connections#settings`;
    const setBlocked = async (blocked: boolean) => {
      const updated = await admin.patch(`${base}/settings`, { block_user_connections: blocked });
      expect(updated.ok(), await updated.text()).toBe(true);
      await page.goto("about:blank");
      await page.goto(agentSettings);
      await page.getByTestId(`member-pick-edit-${integration}`).click();
      await expect(page.getByTestId(`member-pick-renew-${original}`)).toHaveCount(0);
    };
    await setBlocked(true);
    await expect(
      page.getByText(
        /demandez à un administrateur d’en fournir une|ask an administrator to provide one/i,
      ),
    ).toBeVisible();
    const replace = page.getByTestId(`member-pick-new-for-agent-${original}`);
    await expect(replace).toHaveCount(0);
    await setBlocked(false);
    await expect(replace).toBeVisible();
    await expect(
      page.getByText(
        /Les autres épinglages, partages et planifications|Other pins, shares and schedules/,
      ),
    ).toBeVisible();
    const opened = page.waitForEvent("popup");
    await replace.click();
    const popup = await opened;
    await popup.locator("form input").first().fill("local-replacement");
    const selected = page.waitForResponse(
      (r) => r.request().method() === "PUT" && r.url().includes("/me/integration-pins/"),
    );
    await popup.getByRole("button", { name: /Enregistrer|Save/i }).click();
    const saved = await selected;
    expect(saved.ok(), await saved.text()).toBe(true);
    const {
      connection_ids: [newId],
    } = await saved.json();
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(original);
    const rows = await actor.get(`${base}/connections`);
    expect((await rows.json()).data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: original, shared_here: true, needs_reconnection: true }),
        expect.objectContaining({ id: newId, shared_here: false, needs_reconnection: false }),
      ]),
    );
  } finally {
    await context.close();
    await new Promise<void>((resolve, reject) =>
      upstream.close((err) => (err ? reject(err) : resolve())),
    );
  }
});
