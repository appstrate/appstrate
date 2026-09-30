// SPDX-License-Identifier: Apache-2.0

/**
 * A disabled schedule says why: every `disabled_reason` the API can send has a
 * sentence in both locales, and an enabled schedule has none.
 */

import { describe, it, expect } from "bun:test";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import i18n, { i18nReady } from "../../i18n.ts";
import type { ScheduleWireDto } from "@appstrate/shared-types";
import { ScheduleStatusBadge } from "../schedule-status-badge.tsx";
import { useScheduleDisabledReason } from "../../hooks/use-schedule-disabled-reason.ts";

await i18nReady;

type Reason = NonNullable<ScheduleWireDto["disabled_reason"]>;
// A Record, so a reason added to the API without a case here fails the typecheck.
const REASONS = Object.keys({
  user: true,
  actor_invalid: true,
  actor_left_org: true,
  connection_deleted: true,
} satisfies Record<Reason, true>) as Reason[];

function ReasonText({ reason }: { reason: ScheduleWireDto["disabled_reason"] }) {
  return <>{useScheduleDisabledReason(reason) ?? "none"}</>;
}

const render = (node: ReactElement) =>
  renderToStaticMarkup(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
    .replace(/<[^>]+>/g, "")
    .replace(/&#x27;/g, "'");

describe("schedule disabled reason", () => {
  for (const language of ["fr", "en"]) {
    it(`names every reason in ${language}`, async () => {
      await i18n.changeLanguage(language);
      const texts = REASONS.map((reason) => render(<ReasonText reason={reason} />));
      for (const [i, text] of texts.entries()) {
        expect(text).not.toContain(`schedule.disabledReason.${REASONS[i]}`);
      }
      expect(new Set(texts).size).toBe(REASONS.length);
    });
  }

  it("has no reason while enabled, and the badge still reads as the status", async () => {
    await i18n.changeLanguage("en");
    expect(render(<ReasonText reason={null} />)).toBe("none");
    expect(
      render(<ScheduleStatusBadge schedule={{ enabled: false, disabled_reason: "user" }} />),
    ).toBe(i18n.t("schedule.statusDisabled", { ns: "agents" }));
  });
});
