import { useRef, useState } from "react";
import type { FlowDetail } from "@appstrate/shared-types";
import { useUploadPackage, downloadPackage } from "../../hooks/use-mutations";
import { Spinner } from "../spinner";

interface PackageSectionProps {
  detail: FlowDetail | null;
  flowId: string | undefined;
  canEdit: boolean;
  onPackageUploaded?: () => void;
}

export function PackageSection({ detail, flowId, canEdit, onPackageUploaded }: PackageSectionProps) {
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
      alert(`Erreur: ${err instanceof Error ? err.message : String(err)}`);
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
      <div className="editor-section-header">Package ZIP</div>
      <div className="editor-section-body">
        <div className="package-actions">
          {flowId && (
            <button type="button" onClick={handleDownload} disabled={downloading}>
              {downloading ? <Spinner /> : "Telecharger le ZIP"}
            </button>
          )}

          {canEdit && (
            <label className="btn-upload">
              {uploadMutation.isPending ? <Spinner /> : "Uploader un ZIP"}
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

        {uploadSuccess && <p className="editor-success">Package mis a jour avec succes.</p>}
      </div>
    </div>
  );
}
