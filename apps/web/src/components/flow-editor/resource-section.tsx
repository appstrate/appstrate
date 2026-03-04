import { type ChangeEvent, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  usePackageList,
  useUploadPackage,
  PACKAGE_CONFIG,
  type PackageType,
} from "../../hooks/use-packages";
import { Spinner } from "../spinner";

interface ResourceSectionProps {
  type: PackageType;
  title: string;
  emptyLabel: string;
  selectedIds: string[];
  onChange: (ids: string[]) => void;
}

export function ResourceSection({
  type,
  title,
  emptyLabel,
  selectedIds,
  onChange,
}: ResourceSectionProps) {
  const { t } = useTranslation(["flows", "common"]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: items, isLoading } = usePackageList(type);
  const upload = useUploadPackage(type);
  const cfg = PACKAGE_CONFIG[type];

  const toggle = (id: string) => {
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((x) => x !== id));
    } else {
      onChange([...selectedIds, id]);
    }
  };

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const result = await upload.mutateAsync(file);
      const newId = (result as Record<string, { id: string }>)[cfg.detailKey].id;

      if (!selectedIds.includes(newId)) {
        onChange([...selectedIds, newId]);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : t("error.unknown"));
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="editor-section">
      <div className="editor-section-header editor-section-header-actions">
        {title}
        <label className="btn-upload btn-upload-sm">
          {upload.isPending ? <Spinner /> : t("editor.importZip")}
          <input
            type="file"
            accept=".zip"
            ref={fileInputRef}
            onChange={handleUpload}
            className="hidden"
            disabled={upload.isPending}
          />
        </label>
      </div>
      <div className="editor-section-body">
        {isLoading ? (
          <div className="empty-state">
            <Spinner />
          </div>
        ) : !items || items.length === 0 ? (
          <>
            <p className="editor-hint">{emptyLabel}</p>
            <p className="editor-hint">
              <Link to="/?tab=skills">{t("editor.goToPackages")}</Link>
            </p>
          </>
        ) : (
          <div className="pkg-checkbox-list">
            {items.map((item) => (
              <label
                key={item.id}
                className={`pkg-checkbox-item${selectedIds.includes(item.id) ? " checked" : ""}`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <div className="pkg-checkbox-info">
                  <span className="pkg-checkbox-name">{item.name || item.id}</span>
                  {item.description && (
                    <span className="pkg-checkbox-desc">{item.description}</span>
                  )}
                </div>
              </label>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
