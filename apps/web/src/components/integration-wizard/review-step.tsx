// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Alert, AlertDescription, AlertTitle } from "@appstrate/ui/components/alert";
import { PendingButton } from "@/components/app-ui/pending-button";
import { ApiError } from "../../api/errors";
import { FormField } from "../form-field";
import { PackageIcon } from "../package-icon";
import { DiscoveryBadge } from "./discovery-badge";
import { DiscoveryWarnings } from "../integration-editor/discovery-warnings";
import { errorMessage } from "../../lib/mutation-error";
import { packageDetailPath } from "../../lib/package-paths";
import {
  wizardAuthKind,
  type DiscoveryResult,
  type WizardAuthKind,
  type WizardEdits,
} from "../../lib/integration-wizard";
import { WizardSection } from "./wizard-section";

const AUTH_KEYS: Record<WizardAuthKind, string> = {
  oauthAuto: "integrationWizard.review.auth.oauthAuto",
  oauthAdmin: "integrationWizard.review.auth.oauthAdmin",
  apiKey: "integrationWizard.review.auth.apiKey",
  other: "integrationWizard.review.auth.other",
};

/**
 * What the analysis found, to check before anything is created: the name and identifier (both
 * editable), the address, the icon and how an account connects, each marked detected or
 * suggested. The integrations this space already reaches at the same address are listed;
 * creating anyway stays possible.
 */
export function ReviewStep({
  result,
  edits,
  onEditsChange,
  icon,
  onCreate,
  creating,
  createError,
  onManual,
}: {
  result: DiscoveryResult;
  edits: WizardEdits;
  onEditsChange: (edits: WizardEdits) => void;
  /** The proposal's icon, or the site's raster once re-encoded. */
  icon: string | undefined;
  onCreate: () => void;
  /** The way being created, while its request is out. */
  creating: "guided" | "manual" | null;
  createError: unknown;
  onManual: () => void;
}) {
  const { t } = useTranslation("agents");
  const { manifest, provenance } = result;
  const nameTaken = createError instanceof ApiError && createError.code === "name_collision";
  const complete = edits.display_name.trim() !== "" && edits.name.trim() !== "";
  // A value the user changed is theirs: it no longer reads as detected or suggested.
  const edited = (key: keyof WizardEdits) => edits[key] !== manifest[key];
  return (
    <WizardSection
      title={t("integrationWizard.review.title")}
      description={t("integrationWizard.review.description")}
    >
      {result.existing.length > 0 && (
        <Alert variant="info" data-testid="integration-wizard-existing">
          <AlertTitle>{t("integrationWizard.review.existing.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("integrationWizard.review.existing.description")}</p>
            <ul className="mt-2 flex flex-col gap-1">
              {result.existing.map((match) => (
                <li key={match.integration_package_id}>
                  <Link
                    className="text-foreground font-medium underline-offset-4 hover:underline"
                    to={packageDetailPath("integration", match.integration_package_id)}
                  >
                    {match.display_name}
                  </Link>{" "}
                  <code className="text-muted-foreground text-xs">
                    {match.integration_package_id}
                  </code>
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <div className="flex items-start gap-4">
        <PackageIcon type="integration" icon={icon} name={edits.display_name} size="md" />
        <div className="grid min-w-0 flex-1 gap-4 md:grid-cols-2">
          <FormField
            id="integration-wizard-name"
            label={t("integrationWizard.review.displayName")}
            required
            value={edits.display_name}
            onChange={(display_name) => onEditsChange({ ...edits, display_name })}
            disabled={creating !== null}
            badge={
              <DiscoveryBadge
                provenance={edited("display_name") ? undefined : provenance["/display_name"]}
              />
            }
          />
          <FormField
            id="integration-wizard-id"
            label={t("integrationWizard.review.identifier")}
            required
            value={edits.name}
            onChange={(name) => onEditsChange({ ...edits, name })}
            disabled={creating !== null}
            description={t("integrationWizard.review.identifierHint")}
            badge={<DiscoveryBadge provenance={edited("name") ? undefined : provenance["/name"]} />}
            error={nameTaken ? errorMessage(createError) : undefined}
          />
        </div>
      </div>

      <dl className="grid gap-3 text-sm sm:grid-cols-[minmax(0,12rem)_1fr]">
        <dt className="text-muted-foreground">{t("integrationWizard.review.address")}</dt>
        <dd className="min-w-0 break-all">
          <code>{manifest.source.remote.url}</code>
        </dd>
        {icon && (
          <>
            <dt className="text-muted-foreground">{t("integrationWizard.review.icon")}</dt>
            <dd className="flex items-center gap-2">
              <PackageIcon type="integration" icon={icon} size="sm" />
              <DiscoveryBadge provenance={provenance["/icon"] ?? "detected"} />
            </dd>
          </>
        )}
        <dt className="text-muted-foreground">{t("integrationWizard.review.connection")}</dt>
        <dd className="flex flex-col gap-1">
          {manifest.auths ? (
            Object.entries(manifest.auths).map(([key, auth]) => (
              <span key={key} className="flex flex-wrap items-center gap-2">
                {t(AUTH_KEYS[wizardAuthKind(auth)])}
                <DiscoveryBadge provenance={provenance[`/auths/${key}`]} />
              </span>
            ))
          ) : (
            <span data-testid="integration-wizard-no-auth">
              {t("integrationWizard.review.auth.none")}
            </span>
          )}
        </dd>
      </dl>

      {!manifest.auths && (
        <Alert variant="warning" data-testid="integration-wizard-url-shared">
          <AlertTitle>{t("integrationWizard.review.urlShared.title")}</AlertTitle>
          <AlertDescription>{t("integrationWizard.review.urlShared.description")}</AlertDescription>
        </Alert>
      )}

      <DiscoveryWarnings warnings={result.warnings} />

      <div className="border-border flex flex-col gap-3 border-t pt-4">
        <p className="text-muted-foreground text-sm">{t("integrationWizard.review.effect")}</p>
        {createError != null && !nameTaken && (
          <p role="alert" className="text-destructive text-sm">
            {errorMessage(createError)}
          </p>
        )}
        <div className="flex flex-wrap gap-2">
          <PendingButton
            type="button"
            onClick={onCreate}
            pending={creating === "guided"}
            disabled={!complete || creating !== null}
            data-testid="integration-wizard-create"
          >
            {t("integrationWizard.review.create")}
          </PendingButton>
          <PendingButton
            type="button"
            variant="outline"
            onClick={onManual}
            pending={creating === "manual"}
            disabled={!complete || creating !== null}
          >
            {t("integrationWizard.review.manual")}
          </PendingButton>
        </div>
      </div>
    </WizardSection>
  );
}
