// SPDX-License-Identifier: Apache-2.0

/**
 * The billing page renders differently for an org that already subscribes and
 * one that does not: the header offers the subscription portal in the first
 * case and a checkout upgrade in the second.
 *
 * Which endpoint a plan click goes to is NOT decided here — the server sends it
 * as `plan_action`, and the rule it derives that from is tested in
 * `packages/module-ee/test/integration/routes/billing.test.ts`.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/client.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

type BillingAccount = components["schemas"]["EeBillingAccount"];
type Plan = components["schemas"]["EeBillingPlan"];
type UpgradePlan = components["schemas"]["EeBillingUpgradePlan"];

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { $api } = await import("../../api/client.ts");
const { OrgSettingsBillingPage } = await import("../org-settings/billing.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

const i18n = i18nModule.default;
await i18nModule.i18nReady;
await i18n.changeLanguage("fr");

const ORG_ID = "org_a";
const header = { "X-Org-Id": ORG_ID };

// Typed against the generated wire schema, not cast into it: a field added to
// the billing account or its plans stops these fixtures compiling, which is the
// whole point of a fixture. `upgrades` takes the narrower checkout-target type,
// so `free` cannot land there.
const FREE: Plan = {
  id: "free",
  name: "Free",
  price: 0,
  credit_quota: 5000,
  file_storage_bytes: 1,
};
const STARTER: UpgradePlan = {
  id: "starter",
  name: "Starter",
  price: 29,
  credit_quota: 20000,
  file_storage_bytes: 2,
};
const PRO: UpgradePlan = {
  id: "pro",
  name: "Pro",
  price: 99,
  credit_quota: 80000,
  file_storage_bytes: 3,
};
const PLANS: Plan[] = [FREE, STARTER, PRO];

function renderPage(account: BillingAccount): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  queryClient.setQueryData(
    ["orgs"],
    [
      {
        id: ORG_ID,
        name: "Acme",
        slug: "acme",
        role: "member",
        permissions: ["billing:read"],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ],
  );
  queryClient.setQueryData(
    $api.queryOptions("get", "/api/billing", { params: { header } }).queryKey,
    account,
  );
  const snapshot = spyOn(orgStore, "getInitialState").mockReturnValue({
    ...orgStore.getInitialState(),
    id: ORG_ID,
  });
  try {
    return render(<OrgSettingsBillingPage />, { queryClient });
  } finally {
    snapshot.mockRestore();
  }
}

describe("the billing page for a subscribed org", () => {
  const subscribed: BillingAccount = {
    plan: { id: "starter", name: "Starter" },
    plans: PLANS,
    usage_percent: 25,
    credits_used: 5000,
    credit_quota: 20000,
    period_end: "2026-10-01T00:00:00Z",
    status: "active",
    plan_action: "plan-change",
    upgrades: [PRO],
  };

  it("offers the subscription portal instead of a checkout upgrade in the header", () => {
    const html = renderPage(subscribed);
    expect(html).toContain("Gérer l'abonnement");
    expect(html).not.toContain(">Passer à un plan supérieur<");
  });

  it("still lists the plans, which is where a change is taken from", () => {
    const html = renderPage(subscribed);
    expect(html).toContain("Plans disponibles");
    expect(html).toContain("Pro");
  });

  it("offers a checkout upgrade in the header when nothing is subscribed", () => {
    const html = renderPage({
      ...subscribed,
      plan: { id: "free", name: "Free" },
      status: "none",
      plan_action: "checkout",
      upgrades: [STARTER, PRO],
    });
    expect(html).toContain(">Passer à un plan supérieur<");
    expect(html).not.toContain("Gérer l'abonnement");
  });
});
