// SPDX-License-Identifier: Apache-2.0

/**
 * The agent page in « Tous les espaces » acts in the space the reader picks, never in the hidden
 * working space. The case that hid a bug: the hidden working space is a THIRD space where the
 * agent is not placed, so the page first reopens in a space that holds it, then « Lancer » asks
 * between the two spaces it runs in, and the space picked is the one both the detail read made
 * before entering it and the launch name in `X-Space-Id`. With a space selected, « Lancer » runs
 * there at once.
 *
 * The org gets a model so « Lancer » is not held back; the launch is asserted on its request, not
 * on the run, which fails in the background (no provider is reached).
 */

import type { Page, Request } from "@playwright/test";
import { test, expect, createAuthedContext } from "../../fixtures/browser.fixture.ts";
import { activatePackageInSpace, createAgent, createSpace } from "../../helpers/seed.ts";
import { createOverviewContext, seedModel } from "../../helpers/overview.ts";

const spaceOf = (request: Request) => request.headers()["x-space-id"];
const pathOf = (request: Request) => decodeURIComponent(new URL(request.url()).pathname);

/** Every request the page sends to `path` with `method`, in order. */
function recordRequests(page: Page, method: string, path: string): Request[] {
  const seen: Request[] = [];
  page.on("request", (request) => {
    if (request.method() === method && pathOf(request) === path) seen.push(request);
  });
  return seen;
}

test("in « Tous les espaces », « Lancer » asks the space and launches there, read from there", async ({
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  const orgId = browserCtx.org.orgId;
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `across-${Date.now().toString(36)}`;
  const alpha = await createSpace(orgOnlyClient, `Alpha ${Date.now()}`);
  const beta = await createSpace(orgOnlyClient, `Beta ${Date.now()}`);
  // Authored in Alpha (its home, active there), activated in Beta; never placed in Default.
  await createAgent(apiClient.withSpace(alpha.id), scope, name);
  await activatePackageInSpace(orgOnlyClient, beta.id, `${scope}/${name}`);
  await seedModel(apiClient);

  const detailPath = `/api/packages/agents/${scope}/${name}`;
  const launchPath = `/api/agents/${scope}/${name}/run`;

  // The hidden working space is Default, where the agent is not placed.
  const context = await createOverviewContext(
    browser,
    browserCtx.auth,
    orgId,
    browserCtx.org.defaultSpaceId,
  );
  const page = await context.newPage();
  try {
    const detailReads = recordRequests(page, "GET", detailPath);
    const launches = recordRequests(page, "POST", launchPath);

    await page.goto(`/agents/${scope}/${name}`);
    // It reopens in a space that holds it (`?enterSpace=`), then drops the parameter.
    await expect(page).toHaveURL(new RegExp(`/agents/${scope}/${name}$`));
    await expect(page.getByText(`Test Agent ${name}`, { exact: true }).first()).toBeVisible();
    // The header names both spaces it runs in: its home, and Beta behind the count.
    await expect(page.getByText(alpha.name, { exact: true }).first()).toBeVisible();
    await expect(page.getByRole("img", { name: `Partagé avec ${beta.name}` })).toBeVisible();

    // « Lancer » is the menu of the two spaces it runs in.
    await page.getByRole("button", { name: "Lancer", exact: true }).click();
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByText("Lancer dans…", { exact: true })).toBeVisible();
    const entries = menu.getByRole("menuitem");
    await expect(entries).toHaveCount(2);
    await expect(entries.filter({ hasText: alpha.name })).toHaveCount(1);
    await expect(entries.filter({ hasText: beta.name })).toHaveCount(1);
    expect(launches).toHaveLength(0);

    // The redirect entered one of the two; choose the OTHER, so the page must read it there
    // before entering it.
    const entered = await page.evaluate(
      () => Object.values(JSON.parse(localStorage.getItem("appstrate_last_space") ?? "{}"))[0],
    );
    const target = entered === beta.id ? alpha : beta;
    const readsBefore = detailReads.length;
    const launched = page.waitForRequest(
      (request) => request.method() === "POST" && pathOf(request) === launchPath,
    );
    await entries.filter({ hasText: target.name }).click();
    const launch = await launched;
    expect(spaceOf(launch)).toBe(target.id);
    expect(launches).toHaveLength(1);

    // The detail read made on the way, before entering the target, read the target's agent.
    const readOnTheWay = detailReads.slice(readsBefore);
    expect(readOnTheWay.length).toBeGreaterThan(0);
    expect(spaceOf(readOnTheWay[0]!)).toBe(target.id);
  } finally {
    await context.close();
  }
});

test("with a space selected, « Lancer » launches there at once, asking nothing", async ({
  browser,
  browserCtx,
  apiClient,
  orgOnlyClient,
}) => {
  const scope = `@${browserCtx.org.orgSlug}`;
  const name = `here-${Date.now().toString(36)}`;
  const alpha = await createSpace(orgOnlyClient, `Alpha ${Date.now()}`);
  const beta = await createSpace(orgOnlyClient, `Beta ${Date.now()}`);
  await createAgent(apiClient.withSpace(alpha.id), scope, name);
  await activatePackageInSpace(orgOnlyClient, beta.id, `${scope}/${name}`);
  await seedModel(apiClient);
  const launchPath = `/api/agents/${scope}/${name}/run`;

  const context = await createAuthedContext(
    browser,
    browserCtx.auth,
    browserCtx.org.orgId,
    beta.id,
  );
  const page = await context.newPage();
  try {
    await page.goto(`/agents/${scope}/${name}`);
    await expect(page.getByText(`Test Agent ${name}`, { exact: true }).first()).toBeVisible();
    const launched = page.waitForRequest(
      (request) => request.method() === "POST" && pathOf(request) === launchPath,
    );
    await page.getByRole("button", { name: "Lancer", exact: true }).click();
    expect(spaceOf(await launched)).toBe(beta.id);
    await expect(page.getByRole("menu")).toHaveCount(0);
  } finally {
    await context.close();
  }
});
