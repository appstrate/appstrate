// SPDX-License-Identifier: Apache-2.0

/**
 * Picking a plan sends an org that already subscribes somewhere ELSE than an org
 * that does not.
 *
 * Stripe Checkout only ever CREATES a subscription. Sending an upgrade there
 * from an org that already has one left the first running beside the second and
 * charged the customer twice, so the server refuses that combination with a 409
 * and the dashboard must not ask for it. The branch itself is
 * `planSelectionRoute`, pinned directly below — the click that reaches it needs
 * a DOM this runner does not have, and the two halves of the rule (client and
 * `LIVE_SUBSCRIPTION_STATUSES` / `HELD_SUBSCRIPTION_STATUSES` on the server)
 * have to agree or every click lands on a refusal.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { installFakeStorage } from "../../test/fake-storage.ts";

installFakeStorage({
  __APP_CONFIG__: { features: {}, trustedOrigins: [] },
});

const { $api } = await import("../../api/client.ts");
const { planSelectionRoute } = await import("../../hooks/use-billing.ts");
const { OrgSettingsBillingPage } = await import("../org-settings/billing.tsx");
const { orgStore } = await import("../../stores/org-store.ts");
const { render } = await import("../../test/render.tsx");
const i18nModule = await import("../../i18n.ts");

const i18n = i18nModule.default;
await i18nModule.i18nReady;
await i18n.changeLanguage("fr");

const ORG_ID = "org_a";
const header = { "X-Org-Id": ORG_ID };

const PLANS = [
  { id: "free" as const, name: "Free", price: 0, credit_quota: 5000, file_storage_bytes: 1 },
  {
    id: "starter" as const,
    name: "Starter",
    price: 29,
    credit_quota: 20000,
    file_storage_bytes: 2,
  },
  { id: "pro" as const, name: "Pro", price: 99, credit_quota: 80000, file_storage_bytes: 3 },
];

function renderPage(account: Record<string, unknown>): string {
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

describe("planSelectionRoute", () => {
  it("changes the subscription in place for every status Stripe still collects on", () => {
    for (const status of ["active", "trialing", "past_due", "canceling"] as const) {
      expect(planSelectionRoute(status)).toBe("plan-change");
    }
  });

  it("opens a checkout only when Stripe holds no subscription", () => {
    // The two statuses at which the server accepts a checkout: it holds
    // nothing to duplicate.
    for (const status of ["none", "canceled"] as const) {
      expect(planSelectionRoute(status)).toBe("checkout");
    }
  });

  it("sends a suspended subscription to the portal, where neither other door is open", () => {
    // Stripe still HOLDS these, so a checkout is refused (409
    // `subscription_exists`); it no longer collects on them, so a plan change is
    // refused too (409 `no_active_subscription`).
    for (const status of ["unpaid", "paused", "incomplete"] as const) {
      expect(planSelectionRoute(status)).toBe("portal");
    }
  });
});

describe("the billing page for a subscribed org", () => {
  const subscribed = {
    plan: { id: "starter", name: "Starter" },
    plans: PLANS,
    usage_percent: 25,
    credits_used: 5000,
    credit_quota: 20000,
    period_end: "2026-10-01T00:00:00Z",
    status: "active",
    upgrades: [PLANS[2]],
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
      upgrades: [PLANS[1], PLANS[2]],
    });
    expect(html).toContain(">Passer à un plan supérieur<");
    expect(html).not.toContain("Gérer l'abonnement");
  });
});
