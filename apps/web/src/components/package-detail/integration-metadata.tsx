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
 * Every manifest-supplied URL goes through `safeExternalUrl` before reaching
 * an `href`; a rejected URL degrades to plain text, never a dropped row.
 */

import type React from "react";
import { useTranslation } from "react-i18next";
import { Badge } from "@appstrate/ui/components/badge";
import { safeExternalUrl } from "../../lib/safe-url";
// Canonical wire type, imported straight from shared-types rather than the
// hooks re-export so this module has no runtime edge into the data layer.
import type { IntegrationManifestView } from "@appstrate/shared-types";

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
          const href = safeExternalUrl(step.url);
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

export function MetadataBlock({ manifest }: { manifest: IntegrationManifestView }) {
  const { t } = useTranslation("settings");
  const authorRaw = (manifest as { author?: unknown }).author;
  const author =
    typeof authorRaw === "string"
      ? authorRaw
      : authorRaw && typeof authorRaw === "object" && "name" in authorRaw
        ? (((authorRaw as { name?: unknown }).name as string | undefined) ?? "")
        : "";
  const repoRaw = (manifest as { repository?: unknown }).repository;
  const repo =
    typeof repoRaw === "string"
      ? repoRaw
      : repoRaw && typeof repoRaw === "object" && "url" in repoRaw
        ? (((repoRaw as { url?: unknown }).url as string | undefined) ?? "")
        : "";
  // A manifest can declare any string here. Link only what is provably an
  // http(s) target; anything else stays readable as text so the person
  // auditing the package still sees exactly what the publisher wrote.
  const repoHref = safeExternalUrl(repo);
  const sourceKind = manifest.source?.kind ?? "api";
  const rows: Array<[string, React.ReactNode]> = [
    [t("integration.field.version"), <span className="font-mono">{manifest.version}</span>],
    [t("integration.field.author"), author || "—"],
    [t("integration.field.license"), manifest.license ?? "—"],
    [
      t("integration.field.repository"),
      repoHref ? (
        <a
          href={repoHref}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary underline"
        >
          {repo}
        </a>
      ) : (
        repo || "—"
      ),
    ],
    [t("integration.field.serverType"), <span className="font-mono">{sourceKind}</span>],
    ...(manifest.allow_undeclared_tools === true
      ? ([
          [
            t("integration.field.allowUndeclaredTools"),
            <Badge
              variant="outline"
              className="text-[0.65rem]"
              data-testid="integration-meta-wildcard-badge"
            >
              {t("integration.field.allowUndeclaredToolsBadge")}
            </Badge>,
          ],
        ] as Array<[string, React.ReactNode]>)
      : []),
  ];
  return (
    <dl className="grid grid-cols-1 gap-y-2 text-sm sm:grid-cols-[max-content_1fr] sm:gap-x-4">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted-foreground">{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}
