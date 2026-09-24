// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import type { PackageType } from "@appstrate/core/validation";
import { bumpVersion, planPublishVersion, type VersionBump } from "@appstrate/core/semver";
import { Modal } from "./modal";
import { Button } from "@appstrate/ui/components/button";
import { Label } from "@appstrate/ui/components/label";
import { Spinner } from "./spinner";
import { useCreateVersion, useVersionInfo } from "../hooks/use-packages";
import { getErrorMessage } from "@appstrate/core/errors";
import { ApiError } from "../api/errors";
import { translateSkillFrontmatterError } from "../lib/skill-frontmatter";

interface CreateVersionModalProps {
  open: boolean;
  onClose: () => void;
  type: PackageType;
  packageId: string;
  hasUnarchivedChanges?: boolean;
  /** The draft's `ETag` as displayed: publishing refuses a draft moved since. */
  etag?: string | null;
}

type FormData = { selectedBump: VersionBump };

export function CreateVersionModal({
  open,
  onClose,
  type,
  packageId,
  hasUnarchivedChanges = true,
  etag,
}: CreateVersionModalProps) {
  const { t } = useTranslation("agents");
  const { data: versionInfo } = useVersionInfo(type, packageId);
  const createVersion = useCreateVersion(type, packageId);

  const {
    setValue,
    setError,
    control,
    formState: { errors },
  } = useForm<FormData>({
    defaultValues: { selectedBump: "patch" },
  });

  const selectedBump = useWatch({ control, name: "selectedBump" });

  const latestVersion = versionInfo?.latest_published_version ?? null;
  const activeVersion = versionInfo?.active_version ?? null;

  const plan = planPublishVersion(activeVersion, latestVersion, selectedBump);
  const needsBump = plan.kind === "bump";
  const isBlocked = plan.kind === "blocked";
  // The button names the draft's own version when no bump applies — a blocked
  // draft included, so the author sees which version was refused.
  const targetVersion = plan.target ?? activeVersion;

  const canCreate = (needsBump || plan.kind === "direct") && hasUnarchivedChanges;

  const handleFormSubmit = () => {
    setError("root", { message: "" });
    createVersion.mutate(
      { version: plan.override, etag },
      {
        onSuccess: () => {
          onClose();
        },
        onError: (err) => {
          // The publish gate re-checks the stored SKILL.md, so a frontmatter
          // code arrives here too.
          const refused =
            err instanceof ApiError && err.code === "no_changes"
              ? t("version.noChanges")
              : err instanceof ApiError && err.code === "precondition_failed"
                ? t("version.draftChanged")
                : null;
          setError("root", {
            message: refused ?? translateSkillFrontmatterError(err, t) ?? getErrorMessage(err),
          });
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
    <Modal
      open={open}
      onClose={onClose}
      title={t("version.createVersion")}
      actions={
        <Button onClick={handleFormSubmit} disabled={!canCreate || createVersion.isPending}>
          {createVersion.isPending && <Spinner />}{" "}
          {targetVersion
            ? t("version.createVersionX", { version: targetVersion })
            : t("version.createVersion")}
        </Button>
      }
    >
      <div className="space-y-4">
        <div className="space-y-2">
          {latestVersion && (
            <Label className="block text-sm">
              {t("version.latestPublished")}: <strong>{latestVersion}</strong>
            </Label>
          )}
          {!needsBump && (
            <Label className="block text-sm">
              {t("version.activeVersionLabel")}:{" "}
              <strong>{activeVersion ?? t("version.noVersion")}</strong>
            </Label>
          )}
        </div>

        {needsBump && latestVersion && (
          <div className="space-y-2">
            <Label className="block text-sm font-medium">{t("version.bumpLabel")}</Label>
            <div className="flex gap-2">
              {bumpOptions.map((opt) => {
                const bumped = bumpVersion(latestVersion, opt.type) ?? latestVersion;
                const isSelected = selectedBump === opt.type;
                return (
                  <button
                    key={opt.type}
                    type="button"
                    onClick={() => setValue("selectedBump", opt.type)}
                    className={`flex-1 rounded-md border px-3 py-2 text-sm transition-colors ${
                      isSelected
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border hover:border-muted-foreground"
                    }`}
                  >
                    <div className="font-medium">{opt.label}</div>
                    <div className="text-muted-foreground mt-0.5 text-xs">
                      {latestVersion} &rarr; {bumped}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {isBlocked && activeVersion && latestVersion && (
          <p className="text-warning text-sm">{t("version.mustBeHigher")}</p>
        )}
        {!hasUnarchivedChanges && <p className="text-warning text-sm">{t("version.noChanges")}</p>}
        {!activeVersion && (
          <p className="text-warning text-sm">{t("version.noVersionInManifest")}</p>
        )}
        {errors.root?.message && (
          <div className="text-destructive text-sm">{errors.root.message}</div>
        )}
      </div>
    </Modal>
  );
}
