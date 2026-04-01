import { useTranslation } from "react-i18next";
import { useForm, useWatch } from "react-hook-form";
import type { PackageType } from "@appstrate/core/validation";
import { Modal } from "./modal";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Spinner } from "./spinner";
import { useCreateVersion, useVersionInfo } from "../hooks/use-packages";

/** Simple semver comparison: returns true if a > b (major.minor.patch only). */
function semverGt(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return true;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return false;
  }
  return false;
}

function semverEq(a: string, b: string): boolean {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  return pa[0] === pb[0] && pa[1] === pb[1] && pa[2] === pb[2];
}

type BumpType = "patch" | "minor" | "major";

function bumpVersion(version: string, type: BumpType): string {
  const [major, minor, patch] = version.split(".").map(Number);
  switch (type) {
    case "patch":
      return `${major}.${minor}.${patch + 1}`;
    case "minor":
      return `${major}.${minor + 1}.0`;
    case "major":
      return `${major + 1}.0.0`;
  }
}

interface CreateVersionModalProps {
  open: boolean;
  onClose: () => void;
  type: PackageType;
  packageId: string;
}

type FormData = { selectedBump: BumpType };

export function CreateVersionModal({ open, onClose, type, packageId }: CreateVersionModalProps) {
  const { t } = useTranslation("flows");
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

  const latestVersion = versionInfo?.latestVersion ?? null;
  const draftVersion = versionInfo?.draftVersion ?? null;

  // Mode A: draft === latest -> show bump selector
  const needsBump = !!draftVersion && !!latestVersion && semverEq(draftVersion, latestVersion);
  // Mode B: draft > latest or no latest -> direct create
  const canCreateDirect =
    !!draftVersion && (!latestVersion || semverGt(draftVersion, latestVersion));
  // Mode C: draft < latest (but not equal) -> blocked
  const isBlocked = !!draftVersion && !!latestVersion && !needsBump && !canCreateDirect;

  const targetVersion = needsBump ? bumpVersion(latestVersion, selectedBump) : draftVersion;

  const canCreate = needsBump || canCreateDirect;

  const handleFormSubmit = () => {
    setError("root", { message: "" });
    const versionArg = needsBump ? (targetVersion ?? undefined) : undefined;
    createVersion.mutate(versionArg, {
      onSuccess: () => {
        onClose();
      },
      onError: (err) => {
        setError("root", { message: err instanceof Error ? err.message : String(err) });
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
              {t("version.draftVersionLabel")}:{" "}
              <strong>{draftVersion ?? t("version.noVersion")}</strong>
            </Label>
          )}
        </div>

        {needsBump && (
          <div className="space-y-2">
            <Label className="block text-sm font-medium">{t("version.bumpLabel")}</Label>
            <div className="flex gap-2">
              {bumpOptions.map((opt) => {
                const bumped = bumpVersion(latestVersion, opt.type);
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
                    <div className="text-xs text-muted-foreground mt-0.5">
                      {latestVersion} &rarr; {bumped}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {isBlocked && draftVersion && latestVersion && (
          <p className="text-sm text-warning">{t("version.mustBeHigher")}</p>
        )}
        {!draftVersion && (
          <p className="text-sm text-warning">{t("version.noVersionInManifest")}</p>
        )}
        {errors.root?.message && (
          <div className="text-sm text-destructive">{errors.root.message}</div>
        )}
      </div>
    </Modal>
  );
}
