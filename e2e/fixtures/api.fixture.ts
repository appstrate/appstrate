// SPDX-License-Identifier: Apache-2.0

/**
 * Playwright fixture that provides an authenticated API client
 * with org + space context, ready for space-scoped API tests.
 *
 * Usage in tests:
 *   import { test, expect } from "../fixtures/api.fixture.ts";
 *   test("my test", async ({ apiClient, orgContext }) => { ... });
 */

import { test as base, expect } from "@playwright/test";
import { createApiClient, createOrgOnlyClient, type ApiClient } from "../helpers/api-client.ts";
import { registerUser, createOrg, type AuthResult, type OrgResult } from "../helpers/seed.ts";

interface OrgContext {
  auth: AuthResult;
  org: OrgResult;
}

interface ApiFixtures {
  /** Authenticated API client scoped to a fresh org + default space */
  apiClient: ApiClient;
  /** Org-only client (no X-Space-Id) for org-scoped routes */
  orgOnlyClient: ReturnType<typeof createOrgOnlyClient>;
  /** Auth + org details for the current test context */
  orgContext: OrgContext;
}

export const test = base.extend<ApiFixtures>({
  async orgContext({ request }, use) {
    const auth = await registerUser(request);
    const org = await createOrg(request, auth.cookie);
    await use({ auth, org });
  },

  async apiClient({ request, orgContext }, use) {
    const client = createApiClient(request, {
      cookie: orgContext.auth.cookie,
      orgId: orgContext.org.orgId,
      spaceId: orgContext.org.defaultSpaceId,
    });
    await use(client);
  },

  async orgOnlyClient({ request, orgContext }, use) {
    const client = createOrgOnlyClient(request, orgContext.auth.cookie, orgContext.org.orgId);
    await use(client);
  },
});

export { expect };
