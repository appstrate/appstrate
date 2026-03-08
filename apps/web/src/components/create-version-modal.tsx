import { useState } from "react";
import { useTranslation } from "react-i18next";
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

interface CreateVersionModalProps {
  open: boolean;
  onClose: () => void;
  type: "flow" | "skill" | "extension" | "provider";
  packageId: string;
}

export function CreateVersionModal({ open, onClose, type, packageId }: CreateVersionModalProps) {
  const { t } = useTranslation("flows");
  const { data: versionInfo } = useVersionInfo(type, packageId);
  const createVersion = useCreateVersion(type, packageId);
  const [error, setError] = useState<string | null>(null);

  const latestVersion = versionInfo?.latestVersion ?? null;
  const draftVersion = versionInfo?.draftVersion ?? null;

  const canCreate = !!draftVersion && (!latestVersion || semverGt(draftVersion, latestVersion));

  const handleSubmit = () => {
    setError(null);
    createVersion.mutate(undefined, {
      onSuccess: () => {
        onClose();
      },
      onError: (err) => {
        setError(err instanceof Error ? err.message : String(err));
      },
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("version.createVersion")}
      actions={
        <Button onClick={handleSubmit} disabled={!canCreate || createVersion.isPending}>
          {createVersion.isPending && <Spinner />} {t("version.createVersion")}
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
          <Label className="block text-sm">
            {t("version.draftVersionLabel")}:{" "}
            <strong>{draftVersion ?? t("version.noVersion")}</strong>
          </Label>
        </div>
        {!canCreate && draftVersion && latestVersion && (
          <p className="text-sm text-warning">{t("version.mustBeHigher")}</p>
        )}
        {!canCreate && !draftVersion && (
          <p className="text-sm text-warning">{t("version.noVersionInManifest")}</p>
        )}
        {error && <span className="text-sm text-destructive">{error}</span>}
      </div>
    </Modal>
  );
}
