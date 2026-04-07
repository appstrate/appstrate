// SPDX-License-Identifier: Apache-2.0

/**
 * Playwright fixture providing TWO independent org contexts
 * for cross-org isolation tests.
 *
 * Each context has its own user, org, and default app.
 */

import { test as base, expect } from "@playwright/test";
import { createApiClient, createOrgOnlyClient, type ApiClient } from "../helpers/api-client.ts";
import { registerUser, createOrg, type AuthResult, type OrgResult } from "../helpers/seed.ts";

export interface OrgContext {
  auth: AuthResult;
  org: OrgResult;
}

interface MultiContextFixtures {
  ctxA: OrgContext;
  ctxB: OrgContext;
  /** API client scoped to OrgA's default app */
  clientA: ApiClient;
  /** API client scoped to OrgB's default app */
  clientB: ApiClient;
  /** Org-only client for OrgA */
  orgClientA: ReturnType<typeof createOrgOnlyClient>;
  /** Org-only client for OrgB */
  orgClientB: ReturnType<typeof createOrgOnlyClient>;
}

export const test = base.extend<MultiContextFixtures>({
  async ctxA({ request }, use) {
    const auth = await registerUser(request, { name: "User A" });
    const org = await createOrg(request, auth.cookie, { name: "Org A" });
    await use({ auth, org });
  },

  async ctxB({ request }, use) {
    const auth = await registerUser(request, { name: "User B" });
    const org = await createOrg(request, auth.cookie, { name: "Org B" });
    await use({ auth, org });
  },

  async clientA({ request, ctxA }, use) {
    await use(
      createApiClient(request, {
        cookie: ctxA.auth.cookie,
        orgId: ctxA.org.orgId,
        appId: ctxA.org.defaultAppId,
      }),
    );
  },

  async clientB({ request, ctxB }, use) {
    await use(
      createApiClient(request, {
        cookie: ctxB.auth.cookie,
        orgId: ctxB.org.orgId,
        appId: ctxB.org.defaultAppId,
      }),
    );
  },

  async orgClientA({ request, ctxA }, use) {
    await use(createOrgOnlyClient(request, ctxA.auth.cookie, ctxA.org.orgId));
  },

  async orgClientB({ request, ctxB }, use) {
    await use(createOrgOnlyClient(request, ctxB.auth.cookie, ctxB.org.orgId));
  },
});

export { expect };
