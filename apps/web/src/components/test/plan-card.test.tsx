// SPDX-License-Identifier: Apache-2.0

/**
 * `PlanGrid` rendering tests — the storage entitlement shown next to credits.
 *
 * Same harness as `run-context-gauge.test.tsx`: no DOM, so the component is
 * rendered with `renderToStaticMarkup` and asserted on its HTML, through the
 * SPA's own i18n singleton so the locale under test is the locale the
 * assertions use.
 *
 * The storage entitlement is always on the wire: `@appstrate/cloud` declares
 * `file_storage_bytes` required on `CloudBillingPlan` and sets it on every plan
 * definition, so the card renders the line unconditionally — including for a
 * plan that grants zero, which is a real entitlement and not a missing one.
 */

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n, { i18nReady } from "../../i18n.ts";
import type { BillingPlanDetail } from "../../hooks/use-billing.ts";
import { PlanGrid } from "../plan-card.tsx";

await i18nReady;
await i18n.changeLanguage("fr");

const GIB = 1024 * 1024 * 1024;

function render(plans: BillingPlanDetail[]): string {
  return renderToStaticMarkup(
    <I18nextProvider i18n={i18n}>
      <PlanGrid plans={plans} currentPlanId="free" />
    </I18nextProvider>,
  );
}

describe("PlanGrid storage entitlement", () => {
  it("prices storage under the credits of every plan", () => {
    const html = render([
      { id: "free", name: "Free", price: 0, credit_quota: 5000, file_storage_bytes: GIB },
      {
        id: "pro",
        name: "Pro",
        price: 99,
        credit_quota: 80_000,
        file_storage_bytes: 100 * GIB,
      },
    ]);

    expect(html).toContain("1.0 GB de stockage");
    expect(html).toContain("100 GB de stockage");
  });

  it("still prices a zero entitlement rather than treating it as absent", () => {
    const html = render([
      { id: "free", name: "Free", price: 0, credit_quota: 5000, file_storage_bytes: 0 },
    ]);

    expect(html).toContain("0 B de stockage");
  });
});
