// SPDX-License-Identifier: Apache-2.0

/**
 * The credit gauge shows where the billing tab it links to opens: the billing
 * module loaded and `billing:read` granted. Anywhere else it is not drawn.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { $api, type components } from "../../api/client.ts";
import { SidebarCredits } from "../sidebar-credits.tsx";
import { orgStore } from "../../stores/org-store.ts";
import { render } from "../../test/render.tsx";
import i18n, { i18nReady } from "../../i18n.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

const appConfig = { features: { billing: false } as Record<string, boolean>, trustedOrigins: [] };
installFakeStorage({ __APP_CONFIG__: appConfig });

await i18nReady;
await i18n.changeLanguage("fr");

const ORG_ID = "org_credits";

const account: components["schemas"]["EeBillingAccount"] = {
  plan: { id: "starter", name: "Starter" },
  plans: [],
  usage_percent: 42,
  credits_used: 420,
  credit_quota: 1000,
  period_end: null,
  status: "active",
  plan_action: "plan-change",
  upgrades: [],
};

function gauge(permissions: string[]): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const org: components["schemas"]["Organization"] = {
    id: ORG_ID,
    name: "Credits",
    slug: "credits",
    icon: null,
    color: null,
    role: "admin",
    deleting_at: null,
    permissions,
    createdAt: "2026-09-05T00:00:00Z",
  };
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  queryClient.setQueryData(["orgs"], [org]);
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/billing", { params: { header: { "X-Org-Id": ORG_ID } } })
      .queryKey,
    account,
  );
  try {
    return render(<SidebarCredits />, { queryClient });
  } finally {
    snapshot.mockRestore();
  }
}

describe("the sidebar credit gauge", () => {
  afterEach(() => {
    appConfig.features.billing = false;
  });

  it("shows the credits used against the quota, linking to billing", () => {
    appConfig.features.billing = true;
    const html = gauge(["billing:read"]);
    expect(html).toContain('href="/org-settings/billing"');
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain("Crédits");
  });

  it("is not drawn without billing:read", () => {
    appConfig.features.billing = true;
    expect(gauge([])).toBe("");
  });

  it("is not drawn where the billing module is not loaded", () => {
    expect(gauge(["billing:read"])).toBe("");
  });
});
