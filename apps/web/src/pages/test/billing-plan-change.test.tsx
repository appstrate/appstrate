// SPDX-License-Identifier: Apache-2.0

/**
 * The billing page header offers the subscription portal to an org that already
 * subscribes and a checkout upgrade to one that does not. Which endpoint a plan
 * click goes to is the server's `plan_action`, tested in
 * `packages/module-billing/test/integration/routes/billing.test.ts`.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { components } from "../../api/client.ts";
import { installFakeStorage } from "../../test/fake-storage.ts";

type BillingAccount = components["schemas"]["BillingAccount"];
type Plan = components["schemas"]["BillingPlan"];
type UpgradePlan = components["schemas"]["BillingUpgradePlan"];

installFakeStorage({
  // The billing page redirects when the module is absent, so the flag the
  // billing module contributes has to be on for the page to render at all.
  __APP_CONFIG__: { features: { billing: true }, trustedOrigins: [] },
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

// Typed against the generated wire schema, not cast into it, so a new field
// stops these fixtures compiling. `upgrades` takes the narrower checkout type.
const FREE: Plan = {
  id: "free",
  name: "Free",
  price: 0,
  credit_quota: 5000,
  file_storage_bytes: 1,
  included_compute_minutes: 1000,
  max_concurrent_runs: 3,
};
const STARTER: UpgradePlan = {
  id: "starter",
  name: "Starter",
  price: 29,
  credit_quota: 20000,
  file_storage_bytes: 2,
  included_compute_minutes: null,
  max_concurrent_runs: null,
};
const PRO: UpgradePlan = {
  id: "pro",
  name: "Pro",
  price: 99,
  credit_quota: 80000,
  file_storage_bytes: 3,
  included_compute_minutes: null,
  max_concurrent_runs: null,
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
    compute: {
      used_seconds: 0,
      included_minutes: null,
      usage_percent: 0,
      period_start: "2026-11-01T00:00:00.000Z",
      period_end: "2026-12-01T00:00:00.000Z",
      max_concurrent_runs: null,
    },
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

describe("the compute minutes on the billing page", () => {
  const freeAccount: BillingAccount = {
    plan: { id: "free", name: "Free" },
    plans: PLANS,
    usage_percent: 0,
    credits_used: 0,
    credit_quota: 5000,
    period_end: null,
    status: "none",
    plan_action: "checkout",
    upgrades: [STARTER, PRO],
    compute: {
      used_seconds: 24_700,
      included_minutes: 1000,
      usage_percent: 41,
      period_start: "2026-11-01T00:00:00.000Z",
      period_end: "2026-12-01T00:00:00.000Z",
      max_concurrent_runs: 3,
    },
  };

  it("shows the minutes used out of those included, and when they renew", () => {
    const html = renderPage(freeAccount);
    expect(html).toContain("Minutes de calcul");
    expect(html).toContain("411");
    expect(html).toContain("minutes");
    expect(html).toContain("Remise à zéro le");
    expect(html).toContain("3 exécutions simultanées au plus");
    expect(html).not.toContain("sont utilisées");
  });

  it("warns at 80 % that the minutes are running out", () => {
    const html = renderPage({
      ...freeAccount,
      compute: { ...freeAccount.compute, used_seconds: 49_000, usage_percent: 81 },
    });
    expect(html).toContain("81 % de vos minutes de calcul sont utilisées");
    expect(html).not.toContain("Minutes de calcul épuisées");
  });

  it("says new runs are blocked, and invites to upgrade, once the minutes are used up", () => {
    const html = renderPage({
      ...freeAccount,
      compute: { ...freeAccount.compute, used_seconds: 60_000, usage_percent: 100 },
    });
    expect(html).toContain("Minutes de calcul épuisées");
    expect(html).toContain("Passez en Équipe");
    expect(html).toContain("ne sont pas interrompues");
  });

  it("draws no compute gauge for a plan without a compute quota", () => {
    const html = renderPage({
      ...freeAccount,
      plan: { id: "starter", name: "Starter" },
      compute: { ...freeAccount.compute, included_minutes: null, usage_percent: 0 },
    });
    expect(html).not.toContain("Minutes de calcul");
  });
});
