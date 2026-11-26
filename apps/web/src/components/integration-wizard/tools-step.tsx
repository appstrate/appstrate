// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import type { OrgPackageItemDetail } from "@appstrate/shared-types";
import { Alert, AlertDescription } from "@appstrate/ui/components/alert";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@appstrate/ui/components/field";
import { RadioGroup, RadioGroupItem } from "@appstrate/ui/components/radio-group";
import { PendingButton } from "@/components/app-ui/pending-button";
import { $api } from "../../api/client";
import { ApiError } from "../../api/errors";
import { RoleLimitNotice } from "../role-limit-notice";
import { getAllowUndeclaredTools } from "../integration-editor/utils";
import { usePermissions } from "../../hooks/use-permissions";
import { invalidateIntegrationQueries } from "../../hooks/use-integrations";
import { useUpdatePackage } from "../../hooks/use-mutations";
import { useCreateVersion, type Versioned } from "../../hooks/use-packages";
import { errorMessage } from "../../lib/mutation-error";
import { packageDetailPath } from "../../lib/package-paths";
import { toolsPublishBody } from "../../lib/integration-wizard";
import { WizardSection } from "./wizard-section";

/**
 * How the server's tools reach agents, then one save and one publish: the draft's first version,
 * or the next. The tools themselves are never declared here: the server's listing is read into
 * the tool snapshot, where each space reviews them.
 */
export function ToolsStep({
  packageId,
  draft,
  version,
  published,
}: {
  packageId: string;
  /** The package's working copy, saved under its `ETag`. */
  draft: Versioned<OrgPackageItemDetail>;
  /** The version published. */
  version: string;
  /** A version is already published: the draft's other changes ship with this one. */
  published: boolean;
}) {
  const { t } = useTranslation("agents");
  return (
    <WizardSection
      title={t("integrationWizard.tools.title")}
      description={t("integrationWizard.tools.description")}
    >
      {/* The save is a write in the package's home space, the server's verdict on the draft. */}
      {!draft.home_writable ? (
        <RoleLimitNotice>{t("integrationWizard.tools.notWritable")}</RoleLimitNotice>
      ) : (
        <PublishChoice
          packageId={packageId}
          draft={draft}
          version={version}
          published={published}
        />
      )}
    </WizardSection>
  );
}

function PublishChoice({
  packageId,
  draft,
  version,
  published,
}: {
  packageId: string;
  draft: Versioned<OrgPackageItemDetail>;
  version: string;
  published: boolean;
}) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const [trustAll, setTrustAll] = useState(getAllowUndeclaredTools(draft.manifest ?? {}));
  // Set once the draft is saved: a failed publish is retried alone, on that save.
  const [saved, setSaved] = useState<{ etag: string | null }>();
  // Read when the step opens: our own save sets it afterwards.
  const [unarchivedAtMount] = useState(draft.has_unarchived_changes === true);
  // A publish refused because the draft moved after our save: the next submit saves it again.
  const [draftMoved, setDraftMoved] = useState(false);
  const update = useUpdatePackage("integration", packageId);
  const publish = useCreateVersion("integration", packageId);
  // The first snapshot the tools tab and the spaces' review read; the tab's « Relire le serveur »
  // is the way back when it cannot be taken here.
  const snapshot = $api.useMutation("post", "/api/integrations/{packageId}/tool-snapshot/refresh", {
    meta: { errorHandledByCaller: true },
  });
  // A changed choice is no longer the save a failed publish would retry: the next submit saves it.
  const choose = (next: boolean) => {
    setTrustAll(next);
    setSaved(undefined);
    setDraftMoved(false);
    publish.reset();
  };

  const submit = async () => {
    try {
      let etag = saved?.etag;
      if (!saved) {
        const result = await update.mutateAsync({
          etag: draft.etag ?? "",
          body: toolsPublishBody(draft.manifest ?? {}, { trustAll, version }),
        });
        etag = result.etag;
        setSaved({ etag });
        setDraftMoved(false);
      }
      try {
        await publish.mutateAsync({ version, etag });
      } catch (err) {
        // That save is not the draft any more (the hook re-reads it): save again on the next submit.
        if (err instanceof ApiError && err.code === "precondition_failed") {
          setSaved(undefined);
          setDraftMoved(true);
        }
        throw err;
      }
      if (can("credential-proxy:call-own")) {
        await snapshot
          .mutateAsync({ params: { path: { packageId } }, body: {} })
          .catch(() => undefined);
      }
      // The published version is what the detail reads: once it is there, the step is done.
      await invalidateIntegrationQueries(qc);
    } catch {
      // Said inline from the mutation that failed.
    }
  };

  return (
    <ToolsChoice
      trustAll={trustAll}
      onTrustAllChange={choose}
      // Changes held at mount may be files the step cannot see, or an earlier save of its own: the
      // whole draft is published, so the step warns.
      otherDraftChanges={published && unarchivedAtMount}
      detailPath={packageDetailPath("integration", packageId)}
      version={version}
      onSubmit={() => void submit()}
      pending={update.isPending || publish.isPending || snapshot.isPending}
      saveError={update.error}
      publishError={saved ? publish.error : null}
      draftMoved={draftMoved}
    />
  );
}

/** Review in each space (nothing declared) or trust the whole server (`allow_undeclared_tools`). */
export function ToolsChoice({
  trustAll,
  onTrustAllChange,
  version,
  onSubmit,
  pending,
  saveError,
  publishError,
  draftMoved = false,
  otherDraftChanges,
  detailPath,
}: {
  trustAll: boolean;
  onTrustAllChange: (trustAll: boolean) => void;
  version: string;
  onSubmit: () => void;
  pending: boolean;
  saveError: unknown;
  /** The draft was saved but its version not published. */
  publishError: unknown;
  /** The publish found the draft changed since the save: the next submit saves it again. */
  draftMoved?: boolean;
  /** The draft already differs from the published version: those changes are published too. */
  otherDraftChanges: boolean;
  detailPath: string;
}) {
  const { t } = useTranslation("agents");
  const options = [
    { value: "review", trustAll: false },
    { value: "trust", trustAll: true },
  ] as const;
  return (
    <div className="flex flex-col gap-4">
      <FieldSet className="gap-3" disabled={pending}>
        <FieldLegend variant="label" className="mb-0">
          {t("integrationWizard.tools.modeLabel")}
        </FieldLegend>
        <RadioGroup
          value={trustAll ? "trust" : "review"}
          disabled={pending}
          aria-label={t("integrationWizard.tools.modeLabel")}
          onValueChange={(next) => onTrustAllChange(next === "trust")}
        >
          {options.map((option) => (
            <Field key={option.value} orientation="horizontal" className="items-start">
              <RadioGroupItem
                value={option.value}
                id={`integration-wizard-mode-${option.value}`}
                className="mt-1 shrink-0"
              />
              <FieldContent>
                <FieldLabel
                  htmlFor={`integration-wizard-mode-${option.value}`}
                  className="text-foreground"
                >
                  {t(`integrationWizard.tools.mode.${option.value}.label`)}
                </FieldLabel>
                <FieldDescription>
                  {t(`integrationWizard.tools.mode.${option.value}.description`)}
                </FieldDescription>
              </FieldContent>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <div className="border-border flex flex-col gap-3 border-t pt-4">
        {otherDraftChanges && (
          <Alert variant="warning" data-testid="integration-wizard-draft-changes">
            <AlertDescription>
              {t("integrationWizard.tools.otherDraftChanges", { version })}{" "}
              <Link className="underline underline-offset-4" to={detailPath}>
                {t("integrationWizard.tools.reviewDraft")}
              </Link>
            </AlertDescription>
          </Alert>
        )}
        {saveError != null && (
          <p role="alert" className="text-destructive text-sm">
            {errorMessage(saveError)}
          </p>
        )}
        {draftMoved && (
          <p
            role="alert"
            className="text-destructive text-sm"
            data-testid="integration-wizard-draft-moved"
          >
            {t("integrationWizard.tools.draftMoved", { version })}
          </p>
        )}
        {publishError != null && (
          <p role="alert" className="text-destructive text-sm">
            {t("integrationWizard.tools.publishFailed", { version })} {errorMessage(publishError)}
          </p>
        )}
        <div>
          <PendingButton
            type="button"
            onClick={onSubmit}
            pending={pending}
            data-testid="integration-wizard-publish"
          >
            {publishError != null
              ? t("integrationWizard.tools.retryPublish", { version })
              : t("integrationWizard.tools.submit", { version })}
          </PendingButton>
        </div>
      </div>
    </div>
  );
}
