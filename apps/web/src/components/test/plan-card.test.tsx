// SPDX-License-Identifier: Apache-2.0

/**
 * `PlanGrid` rendering tests — the storage entitlement shown next to credits.
 *
 * Same harness as `run-context-gauge.test.tsx`: no DOM, so the component is
 * rendered with `renderToStaticMarkup` and asserted on its HTML, through the
 * SPA's own i18n singleton so the locale under test is the locale the
 * assertions use.
 *
 * `document_storage_bytes` is optional on the wire: a billing module older than
 * the release that added it omits the field, and the card must then show
 * nothing rather than a "0 B" that misrepresents the plan.
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
      { id: "free", name: "Free", price: 0, credit_quota: 5000, document_storage_bytes: GIB },
      {
        id: "pro",
        name: "Pro",
        price: 99,
        credit_quota: 80_000,
        document_storage_bytes: 100 * GIB,
      },
    ]);

    expect(html).toContain("1.0 GB de stockage");
    expect(html).toContain("100 GB de stockage");
  });

  it("omits the line entirely when the plan reports no storage entitlement", () => {
    const html = render([{ id: "free", name: "Free", price: 0, credit_quota: 5000 }]);

    expect(html).toContain("5,000");
    expect(html).not.toContain("de stockage");
    // Specifically NOT the misleading zero.
    expect(html).not.toContain("0 B");
  });
});
