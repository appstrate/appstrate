// SPDX-License-Identifier: Apache-2.0

import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import type { PackageType } from "@appstrate/core/validation";
import { compareVersionsDesc, bumpVersion } from "@appstrate/core/semver";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "./spinner";
import { useCreateVersion, useVersionInfo } from "../hooks/use-packages";
import { getErrorMessage } from "@appstrate/core/errors";

type BumpType = "patch" | "minor" | "major";

/** a > b — full semver precedence (prerelease/build aware), matching the publish gate. */
const semverGt = (a: string, b: string): boolean => compareVersionsDesc(a, b) < 0;
const semverEq = (a: string, b: string): boolean => compareVersionsDesc(a, b) === 0;

interface CreateVersionModalProps {
  open: boolean;
  onClose: () => void;
  type: PackageType;
  packageId: string;
  hasUnarchivedChanges?: boolean;
}

type FormData = { selectedBump: BumpType };

export function CreateVersionModal({
  open,
  onClose,
  type,
  packageId,
  hasUnarchivedChanges = true,
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

  // Mode A: active === latest -> show bump selector
  const needsBump = !!activeVersion && !!latestVersion && semverEq(activeVersion, latestVersion);
  // Mode B: active > latest or no latest -> direct create
  const canCreateDirect =
    !!activeVersion && (!latestVersion || semverGt(activeVersion, latestVersion));
  // Mode C: active < latest (but not equal) -> blocked
  const isBlocked = !!activeVersion && !!latestVersion && !needsBump && !canCreateDirect;

  const targetVersion = needsBump
    ? (bumpVersion(latestVersion, selectedBump) ?? activeVersion)
    : activeVersion;

  const canCreate = (needsBump || canCreateDirect) && hasUnarchivedChanges;

  const handleFormSubmit = () => {
    setError("root", { message: "" });
    const versionArg = needsBump ? (targetVersion ?? undefined) : undefined;
    createVersion.mutate(versionArg, {
      onSuccess: () => {
        onClose();
      },
      onError: (err) => {
        setError("root", { message: getErrorMessage(err) });
      },
    });
  };

  const bumpOptions: { type: BumpType; label: string }[] = [
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

        {needsBump && (
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
