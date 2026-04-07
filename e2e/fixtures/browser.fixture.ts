// SPDX-License-Identifier: Apache-2.0

/**
 * Shared browser fixture with pre-authenticated session.
 *
 * Provides a Page with cookies and localStorage already set,
 * plus API clients for seeding data.
 */

import { test as base, expect, type Page } from "@playwright/test";
import { registerUser, createOrg, type AuthResult, type OrgResult } from "../helpers/seed.ts";
import { createApiClient, createOrgOnlyClient, type ApiClient } from "../helpers/api-client.ts";

export interface BrowserContext {
  auth: AuthResult;
  org: OrgResult;
}

interface BrowserFixtures {
  authedPage: Page;
  browserCtx: BrowserContext;
  apiClient: ApiClient;
  orgOnlyClient: ReturnType<typeof createOrgOnlyClient>;
}

/**
 * Create an authenticated browser context with org/app localStorage set.
 */
export async function createAuthedContext(
  browser: import("@playwright/test").Browser,
  auth: AuthResult,
  orgId: string,
  appId: string,
): Promise<import("@playwright/test").BrowserContext> {
  const context = await browser.newContext();
  const cookieMatch = auth.cookie.match(/better-auth\.session_token=([^;]+)/);
  if (cookieMatch) {
    await context.addCookies([
      {
        name: "better-auth.session_token",
        value: cookieMatch[1],
        domain: "localhost",
        path: "/",
      },
    ]);
  }
  await context.addInitScript(
    ({ orgId, appId }) => {
      localStorage.setItem("appstrate_current_org", orgId);
      localStorage.setItem("appstrate_current_app", appId);
    },
    { orgId, appId },
  );
  return context;
}

export const test = base.extend<BrowserFixtures>({
  async browserCtx({ request }, use) {
    const auth = await registerUser(request);
    const org = await createOrg(request, auth.cookie);
    await use({ auth, org });
  },

  async authedPage({ browser, browserCtx }, use) {
    const context = await createAuthedContext(
      browser,
      browserCtx.auth,
      browserCtx.org.orgId,
      browserCtx.org.defaultAppId,
    );
    const page = await context.newPage();
    await use(page);
    await context.close();
  },

  async apiClient({ request, browserCtx }, use) {
    await use(
      createApiClient(request, {
        cookie: browserCtx.auth.cookie,
        orgId: browserCtx.org.orgId,
        appId: browserCtx.org.defaultAppId,
      }),
    );
  },

  async orgOnlyClient({ request, browserCtx }, use) {
    await use(createOrgOnlyClient(request, browserCtx.auth.cookie, browserCtx.org.orgId));
  },
});

export { expect };
