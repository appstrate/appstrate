import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { FlowDetail } from "@appstrate/shared-types";
import { useUploadPackage, downloadPackage } from "../../hooks/use-mutations";
import { Spinner } from "../spinner";

interface PackageSectionProps {
  detail: FlowDetail | null;
  flowId: string | undefined;
  canEdit: boolean;
  onPackageUploaded?: () => void;
}

export function PackageSection({
  detail,
  flowId,
  canEdit,
  onPackageUploaded,
}: PackageSectionProps) {
  const { t } = useTranslation(["flows", "common"]);
  const zipFileRef = useRef<HTMLInputElement>(null);
  const uploadMutation = useUploadPackage(flowId || "");

  const [downloading, setDownloading] = useState(false);
  const [uploadSuccess, setUploadSuccess] = useState(false);

  const handleDownload = async () => {
    if (!flowId) return;
    setDownloading(true);
    try {
      await downloadPackage(flowId);
    } catch (err) {
      alert(`${t("error.prefix", { message: err instanceof Error ? err.message : String(err) })}`);
    } finally {
      setDownloading(false);
    }
  };

  const handleUploadZip = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !flowId || !detail?.updatedAt) return;

    setUploadSuccess(false);
    uploadMutation.mutate(
      { file, updatedAt: detail.updatedAt },
      {
        onSuccess: () => {
          setUploadSuccess(true);
          if (zipFileRef.current) zipFileRef.current.value = "";
          onPackageUploaded?.();
        },
      },
    );
  };

  return (
    <div className="editor-section">
      <div className="editor-section-header">{t("editor.packageTitle")}</div>
      <div className="editor-section-body">
        <div className="package-actions">
          {flowId && (
            <button type="button" onClick={handleDownload} disabled={downloading}>
              {downloading ? <Spinner /> : t("editor.downloadZip")}
            </button>
          )}

          {canEdit && (
            <label className="btn-upload">
              {uploadMutation.isPending ? <Spinner /> : t("editor.uploadZip")}
              <input
                ref={zipFileRef}
                type="file"
                accept=".zip"
                onChange={handleUploadZip}
                style={{ display: "none" }}
                disabled={uploadMutation.isPending}
              />
            </label>
          )}
        </div>

        {uploadSuccess && <p className="editor-success">{t("editor.packageSuccess")}</p>}
      </div>
    </div>
  );
}
