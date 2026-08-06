// SPDX-License-Identifier: Apache-2.0

/**
 * Publisher-authored blocks of the integration detail page (setup guide +
 * metadata table).
 *
 * They live here rather than inline in `pages/integration-detail.tsx` because
 * every value they render comes from an AFPS manifest — third-party data in a
 * navigation sink — and that has to be coverable by a test. The page module
 * pulls the whole data layer on import and cannot be rendered in the SPA's
 * DOM-less test harness; these two are pure and prop-driven, so they can.
 *
 * Every manifest-supplied URL goes through `normalizeHttpUrl` before reaching
 * an `href`; a rejected URL degrades to plain text, never a dropped row.
 */

import { useTranslation } from "react-i18next";
import { normalizeHttpUrl } from "@appstrate/core/url";

/**
 * AFPS §7.10 — `setup_guide.steps` is the canonical place for integration
 * publishers to describe IdP-side prerequisites (create an OAuth app, add a
 * redirect URI, …). Rendered as an ordered list on the admin view next to
 * the OAuth client form so the operator has the publisher's instructions at
 * eye level. Each step is `{ label: string, url?: string }`; the `url`
 * surfaces as a clickable link when present — and only when it is an
 * `http(s)` URL, since it is publisher-controlled.
 */
export function SetupGuideSteps({
  steps,
}: {
  steps: ReadonlyArray<{ label: string; url?: string }>;
}) {
  const { t } = useTranslation("settings");
  if (steps.length === 0) return null;
  return (
    <section
      className="bg-muted/20 mb-4 rounded-md border p-4"
      data-testid="setup-guide-steps"
      aria-label={t("integration.setup_guide.step_label")}
    >
      <h3 className="mb-2 text-sm font-semibold">{t("integration.setup_guide.title")}</h3>
      <ol className="text-muted-foreground list-decimal space-y-1 pl-5 text-xs">
        {steps.map((step, i) => {
          const href = normalizeHttpUrl(step.url);
          return (
            <li key={i} data-testid={`setup-guide-step-${i}`}>
              {href ? (
                <a
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary underline"
                >
                  {step.label}
                </a>
              ) : (
                <span>{step.label}</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
