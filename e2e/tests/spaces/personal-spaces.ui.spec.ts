// SPDX-License-Identifier: Apache-2.0

/**
 * Personal spaces, end to end (RBAC spec §3.6).
 *
 * Two things a route test cannot show: that the switcher actually offers
 * "Mon espace" pinned above the team spaces, and that an agent authored there
 * is invisible to the rest of the organization in the SPA — the library page a
 * colleague opens, and the direct URL an admin might be handed.
 */

import type { APIRequestContext } from "@playwright/test";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { createAgent, registerUser, type AuthResult } from "../../helpers/seed.ts";
import { createApiClient } from "../../helpers/api-client.ts";

/** Every space `GET /api/spaces` shows this session, personal flag included. */
async function listSpaces(
  request: APIRequestContext,
  cookie: string,
  orgId: string,
): Promise<Array<{ id: string; personal: boolean; isDefault: boolean }>> {
  const res = await request.get("/api/spaces", { headers: { Cookie: cookie, "X-Org-Id": orgId } });
  expect(res.status()).toBe(200);
  return (await res.json()).data;
}

async function personalSpaceOf(
  request: APIRequestContext,
  cookie: string,
  orgId: string,
): Promise<string> {
  const own = (await listSpaces(request, cookie, orgId)).filter((s) => s.personal);
  expect(own).toHaveLength(1);
  return own[0]!.id;
}

test("the switcher pins the caller's own space above the team spaces", async ({
  authedPage: page,
  request,
  browserCtx,
}) => {
  // Provisioned when the org was created; the listing below is also what would
  // repair it, so this asserts the wire flag as well as the UI.
  const personalId = await personalSpaceOf(request, browserCtx.auth.cookie, browserCtx.org.orgId);

  await page.goto("/agents");
  await page.getByTestId("org-switcher-button").click();
  await page.getByTestId("space-submenu-trigger").click();

  const personalItem = page.getByTestId(`space-item-${personalId}`);
  await expect(personalItem).toBeVisible();
  await expect(personalItem).toContainText(/^(Mon espace|My space)/);

  // Pinned: the personal entry comes before the default team space in the menu.
  const items = await page.getByTestId(/^space-item-/).all();
  const ids = await Promise.all(items.map((item) => item.getAttribute("data-testid")));
  expect(ids[0]).toBe(`space-item-${personalId}`);
  expect(ids).toContain(`space-item-${browserCtx.org.defaultSpaceId}`);
});

test("an agent authored in a personal space is invisible to a colleague and to the admin", async ({
  request,
  browser,
  browserCtx,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const author = await registerUser(request);
  const colleague = await registerUser(request);

  async function join(user: AuthResult) {
    const invited = await orgOnlyClient.post(`/orgs/${orgId}/members`, {
      email: user.email,
      role: "member",
      space_assignments: [],
    });
    expect(invited.status()).toBe(201);
    const { token } = await invited.json();
    const accepted = await request.post(`/invite/${token}/accept`, {
      headers: { Cookie: user.cookie, Origin: "http://localhost:3000" },
    });
    expect(accepted.status()).toBe(200);
  }
  await join(author);
  await join(colleague);

  const personalId = await personalSpaceOf(request, author.cookie, orgId);
  const authorClient = createApiClient(request, {
    cookie: author.cookie,
    orgId,
    spaceId: personalId,
  });
  const scope = `@personal-${Date.now().toString(36)}`;
  await createAgent(authorClient, scope, "draft");
  const agentPath = `/agents/${scope}/draft`;

  // The author sees it in their own space.
  const authorContext = await createAuthedContext(browser, author, orgId, personalId);
  try {
    const authorPage = await authorContext.newPage();
    await authorPage.goto("/library");
    await expect(authorPage.getByText(`${scope}/draft`).first()).toBeVisible();
    await authorPage.goto(agentPath);
    await expect(authorPage.getByText(`${scope}/draft`).first()).toBeVisible();
  } finally {
    await authorContext.close();
  }

  // Nobody else does — a colleague in the same org, and the org OWNER, each in
  // the space they can actually enter. The direct URL is the important half:
  // the library merely omits it, the detail route has to refuse it.
  for (const other of [colleague, browserCtx.auth]) {
    const context = await createAuthedContext(browser, other, orgId, browserCtx.org.defaultSpaceId);
    try {
      const page = await context.newPage();
      await page.goto("/library");
      await expect(page.getByText(`${scope}/draft`)).toHaveCount(0);

      const detail = page.waitForResponse(
        (response) =>
          response.request().method() === "GET" &&
          response.url().includes(`/api/packages/agents/${scope}/draft`),
      );
      await page.goto(agentPath);
      expect((await detail).status()).toBe(404);
    } finally {
      await context.close();
    }
  }

  // …and the personal space is not even listed to them.
  for (const other of [colleague, browserCtx.auth]) {
    const listed = await listSpaces(request, other.cookie, orgId);
    expect(listed.map((s) => s.id)).not.toContain(personalId);
  }
});
