// SPDX-License-Identifier: Apache-2.0

/**
 * Browser fixture with a single user belonging to TWO organizations.
 * Used for org-switching UI tests.
 */

import { test as base, expect, type Page } from "@playwright/test";
import { registerUser, createOrg, type AuthResult, type OrgResult } from "../helpers/seed.ts";
import { createApiClient, type ApiClient } from "../helpers/api-client.ts";
import { createAuthedContext } from "./browser.fixture.ts";

interface MultiOrgBrowserFixtures {
  auth: AuthResult;
  orgA: OrgResult;
  orgB: OrgResult;
  clientA: ApiClient;
  clientB: ApiClient;
  authedPage: Page;
}

export const test = base.extend<MultiOrgBrowserFixtures>({
  async auth({ request }, use) {
    const auth = await registerUser(request, { name: "Multi-Org User" });
    await use(auth);
  },

  async orgA({ request, auth }, use) {
    const org = await createOrg(request, auth.cookie, { name: "UI Org Alpha" });
    await use(org);
  },

  // Depends on orgA to serialize org creation (PGlite concurrency)
  async orgB({ request, auth, orgA }, use) {
    void orgA;
    const org = await createOrg(request, auth.cookie, { name: "UI Org Beta" });
    await use(org);
  },

  async clientA({ request, auth, orgA }, use) {
    await use(
      createApiClient(request, {
        cookie: auth.cookie,
        orgId: orgA.orgId,
        applicationId: orgA.defaultAppId,
      }),
    );
  },

  async clientB({ request, auth, orgB }, use) {
    await use(
      createApiClient(request, {
        cookie: auth.cookie,
        orgId: orgB.orgId,
        applicationId: orgB.defaultAppId,
      }),
    );
  },

  async authedPage({ browser, auth, orgA }, use) {
    const context = await createAuthedContext(browser, auth, orgA.orgId, orgA.defaultAppId);
    const page = await context.newPage();
    await use(page);
    await context.close();
  },
});

export { expect };
