import { type ChangeEvent, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import {
  usePackageList,
  useUploadPackage,
  usePackageVersions,
  PACKAGE_CONFIG,
  type PackageType,
} from "../../hooks/use-packages";
import { Spinner } from "../spinner";
import type { ResourceEntry } from "./types";

interface ResourceSectionProps {
  type: PackageType;
  title: string;
  emptyLabel: string;
  selectedEntries: ResourceEntry[];
  onChange: (entries: ResourceEntry[]) => void;
}

function VersionSelect({
  type,
  packageId,
  value,
  onChange,
}: {
  type: PackageType;
  packageId: string;
  value: string;
  onChange: (version: string) => void;
}) {
  const { data: versions, isLoading } = usePackageVersions(type, packageId);
  const available = useMemo(() => versions?.filter((v) => !v.yanked), [versions]);
  const latestVersion = available?.[0]?.version;

  // Sync state when current value doesn't match any available option
  useEffect(() => {
    if (!latestVersion) return;
    if (value !== "*" && available!.some((v) => v.version === value)) return;
    onChange(latestVersion);
  }, [latestVersion, available, value]); // eslint-disable-line react-hooks/exhaustive-deps

  if (isLoading) return <Spinner />;
  if (!available || available.length === 0) {
    return <span className="version-badge">*</span>;
  }

  return (
    <select
      className="version-select"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={(e) => e.stopPropagation()}
    >
      {value === "*" && <option value="*">*</option>}
      {available.map((v) => (
        <option key={v.id} value={v.version}>
          {v.version}
        </option>
      ))}
    </select>
  );
}

export function ResourceSection({
  type,
  title,
  emptyLabel,
  selectedEntries,
  onChange,
}: ResourceSectionProps) {
  const { t } = useTranslation(["flows", "common"]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data: items, isLoading } = usePackageList(type);
  const upload = useUploadPackage(type);
  const cfg = PACKAGE_CONFIG[type];

  const selectedMap = new Map(selectedEntries.map((e) => [e.id, e]));

  const toggle = (id: string) => {
    if (selectedMap.has(id)) {
      onChange(selectedEntries.filter((e) => e.id !== id));
    } else {
      const item = items?.find((i) => i.id === id);
      const version = item?.lastPublishedVersion ?? item?.version ?? "*";
      onChange([...selectedEntries, { id, version }]);
    }
  };

  const updateVersion = (id: string, version: string) => {
    onChange(selectedEntries.map((e) => (e.id === id ? { ...e, version } : e)));
  };

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const result = await upload.mutateAsync(file);
      const newId = (result as Record<string, { id: string }>)[cfg.detailKey].id;

      if (!selectedMap.has(newId)) {
        onChange([...selectedEntries, { id: newId, version: "*" }]);
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
            {items.map((item) => {
              const isSelected = selectedMap.has(item.id);
              const isBuiltIn = item.source === "built-in";
              const entry = selectedMap.get(item.id);

              return (
                <label key={item.id} className={`pkg-checkbox-item${isSelected ? " checked" : ""}`}>
                  <input type="checkbox" checked={isSelected} onChange={() => toggle(item.id)} />
                  <div className="pkg-checkbox-info">
                    <span className="pkg-checkbox-name">{item.name || item.id}</span>
                    {item.description && (
                      <span className="pkg-checkbox-desc">{item.description}</span>
                    )}
                  </div>
                  {isSelected && (
                    <div className="pkg-checkbox-version">
                      {isBuiltIn ? (
                        <span className="version-badge">{t("editor.builtIn", "Integree")}</span>
                      ) : (
                        <VersionSelect
                          type={type}
                          packageId={item.id}
                          value={entry?.version ?? "*"}
                          onChange={(v) => updateVersion(item.id, v)}
                        />
                      )}
                    </div>
                  )}
                </label>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
