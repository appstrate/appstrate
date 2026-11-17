// SPDX-License-Identifier: Apache-2.0

import { useState, type FormEvent } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { PackageType } from "@appstrate/core/validation";
import { bumpVersion, planPublishVersion, type VersionBump } from "@appstrate/core/semver";
import { FormModal } from "./form-modal";
import { Field } from "@appstrate/ui/components/field";
import { Label } from "@appstrate/ui/components/label";
import { ToggleGroup, ToggleGroupItem } from "@appstrate/ui/components/toggle-group";
import { useCreateVersion, useVersionInfo } from "../hooks/use-packages";
import { ApiError } from "../api/errors";
import { errorMessage } from "../lib/mutation-error";

interface CreateVersionModalProps {
  onClose: () => void;
  type: PackageType;
  packageId: string;
  hasUnarchivedChanges?: boolean;
  /** The draft's `ETag` as displayed: publishing refuses a draft moved since. */
  etag?: string | null;
}

export function CreateVersionModal({
  onClose,
  type,
  packageId,
  hasUnarchivedChanges = true,
  etag,
}: CreateVersionModalProps) {
  const { t } = useTranslation("agents");
  const { data: versionInfo } = useVersionInfo(type, packageId);
  const createVersion = useCreateVersion(type, packageId);

  const [selectedBump, setSelectedBump] = useState<VersionBump>("patch");
  const [error, setError] = useState<string | null>(null);

  const latestVersion = versionInfo?.latest_published_version ?? null;
  const activeVersion = versionInfo?.active_version ?? null;

  const plan = planPublishVersion(activeVersion, latestVersion, selectedBump);
  const needsBump = plan.kind === "bump";
  const isBlocked = plan.kind === "blocked";
  // The button names the draft's own version when no bump applies — a blocked
  // draft included, so the author sees which version was refused.
  const targetVersion = plan.target ?? activeVersion;

  const canCreate = (needsBump || plan.kind === "direct") && hasUnarchivedChanges;

  const handleFormSubmit = (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    createVersion.mutate(
      { version: plan.override, etag },
      {
        onSuccess: onClose,
        onError: (err) => {
          // The publish gate re-checks the stored SKILL.md, so a frontmatter
          // code arrives here too.
          const refused =
            err instanceof ApiError && err.code === "no_changes"
              ? t("version.noChanges")
              : err instanceof ApiError && err.code === "precondition_failed"
                ? t("version.draftChanged")
                : null;
          setError(refused ?? errorMessage(err));
        },
      },
    );
  };

  const bumpOptions: { type: VersionBump; label: string }[] = [
    { type: "patch", label: t("version.bumpPatch") },
    { type: "minor", label: t("version.bumpMinor") },
    { type: "major", label: t("version.bumpMajor") },
  ];

  return (
    <FormModal
      onClose={onClose}
      title={t("version.createVersion")}
      onSubmit={handleFormSubmit}
      isPending={createVersion.isPending}
      submitDisabled={!canCreate}
      submitLabel={
        targetVersion && hasUnarchivedChanges
          ? t("version.createVersionX", { version: targetVersion })
          : t("version.createVersion")
      }
      error={error}
    >
      <div className="flex flex-col gap-2 text-sm">
        {latestVersion && (
          <p>
            <Trans
              t={t}
              i18nKey="version.latestPublished"
              values={{ version: latestVersion }}
              components={{ b: <strong /> }}
            />
          </p>
        )}
        {!needsBump && (
          <p>
            <Trans
              t={t}
              i18nKey="version.activeVersionLabel"
              values={{ version: activeVersion ?? t("version.noVersion") }}
              components={{ b: <strong /> }}
            />
          </p>
        )}
      </div>

      {needsBump && latestVersion && hasUnarchivedChanges && (
        <Field>
          <Label id="version-bump">{t("version.bumpLabel")}</Label>
          <ToggleGroup
            type="single"
            variant="outline"
            aria-labelledby="version-bump"
            className="grid grid-cols-3"
            value={selectedBump}
            onValueChange={(next) => next && setSelectedBump(next as VersionBump)}
          >
            {bumpOptions.map((opt) => (
              <ToggleGroupItem
                key={opt.type}
                value={opt.type}
                className="h-auto flex-col gap-0.5 py-2"
              >
                <span>{opt.label}</span>
                <span className="text-muted-foreground text-xs font-normal">
                  {latestVersion} &rarr; {bumpVersion(latestVersion, opt.type) ?? latestVersion}
                </span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Field>
      )}

      {isBlocked && activeVersion && latestVersion && (
        <p className="text-warning text-sm">{t("version.mustBeHigher")}</p>
      )}
      {!hasUnarchivedChanges && <p className="text-warning text-sm">{t("version.noChanges")}</p>}
      {!activeVersion && <p className="text-warning text-sm">{t("version.noVersionInManifest")}</p>}
    </FormModal>
  );
}
