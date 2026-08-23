// SPDX-License-Identifier: Apache-2.0

/**
 * `PlanGrid` rendering tests — the storage entitlement shown next to credits.
 *
 * Same harness as `run-context-gauge.test.tsx`: no DOM, so the component is
 * rendered with `renderToStaticMarkup` and asserted on its HTML, through the
 * SPA's own i18n singleton so the locale under test is the locale the
 * assertions use.
 *
 * The storage entitlement is optional on the wire: a billing module older than
 * the release that added it omits the field, and the card must then show
 * nothing rather than a "0 B" that misrepresents the plan.
 *
 * It also arrives under EITHER spelling. `@appstrate/cloud` mints this field
 * from another repo, on its own deploy clock: #1177 renamed the concept to
 * `file_storage_bytes`, and the module in front of this SPA may still be
 * sending `document_storage_bytes`. Both are asserted below — reading only one
 * makes the storage line silently vanish on one side of the rename.
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

  it("still reads the pre-#1177 `document_storage_bytes` spelling", () => {
    const html = render([
      { id: "free", name: "Free", price: 0, credit_quota: 5000, document_storage_bytes: GIB },
    ]);
    expect(html).toContain("1.0 GB de stockage");
  });

  it("prefers the current spelling when a module sends both", () => {
    const html = render([
      {
        id: "free",
        name: "Free",
        price: 0,
        credit_quota: 5000,
        file_storage_bytes: 2 * GIB,
        document_storage_bytes: GIB,
      },
    ]);
    expect(html).toContain("2.0 GB de stockage");
    expect(html).not.toContain("1.0 GB de stockage");
  });

  it("omits the line entirely when the plan reports no storage entitlement", () => {
    const html = render([{ id: "free", name: "Free", price: 0, credit_quota: 5000 }]);

    expect(html).toContain("5,000");
    expect(html).not.toContain("de stockage");
    // Specifically NOT the misleading zero.
    expect(html).not.toContain("0 B");
  });
});
