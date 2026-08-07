// SPDX-License-Identifier: Apache-2.0

/**
 * Publisher-authored setup instructions from an integration manifest.
 *
 * This stays separate from the page because each URL crosses a navigation
 * trust boundary and the pure component can be covered without mounting the
 * integration page's data layer.
 */

import { useTranslation } from "react-i18next";
import { normalizeHttpUrl } from "@appstrate/core/url";

/**
 * AFPS §7.10 setup steps shown next to the OAuth client form. Unsafe URLs
 * degrade to plain text so the instruction remains visible without creating a
 * publisher-controlled navigation sink.
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
