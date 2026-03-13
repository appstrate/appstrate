import { type ChangeEvent, useMemo, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import {
  usePackageList,
  useUploadPackage,
  usePackageVersions,
  type PackageType,
} from "../../hooks/use-packages";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "../spinner";
import type { ResourceEntry } from "./types";

interface ResourceSectionProps {
  type: PackageType;
  title: string;
  emptyLabel: string;
  selectedEntries: ResourceEntry[];
  onChange: (entries: ResourceEntry[]) => void;
}

export function VersionSelect({
  type,
  packageId,
  value,
  onChange,
}: {
  type: PackageType | "flow" | "provider";
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
    return (
      <span className="inline-block rounded bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
        *
      </span>
    );
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-7 w-[80px] text-xs" onClick={(e) => e.stopPropagation()}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {value === "*" && <SelectItem value="*">*</SelectItem>}
        {available.map((v) => (
          <SelectItem key={v.id} value={v.version}>
            {v.version}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
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

  const selectedMap = new Map(selectedEntries.map((e) => [e.id, e]));

  const toggle = (id: string) => {
    if (selectedMap.has(id)) {
      onChange(selectedEntries.filter((e) => e.id !== id));
    } else {
      const item = items?.find((i) => i.id === id);
      const version = item?.version ?? "*";
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
      const newId = result.packageId;

      if (!selectedMap.has(newId)) {
        onChange([...selectedEntries, { id: newId, version: "*" }]);
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : t("error.unknown"));
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card mb-4">
      <div className="bg-background px-4 py-3 text-xs font-semibold uppercase tracking-wide text-foreground border-b border-border flex items-center justify-between">
        {title}
        <label className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground hover:bg-muted transition-colors cursor-pointer normal-case tracking-normal">
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
      <div className="space-y-3 p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-6 text-muted-foreground">
            <Spinner />
          </div>
        ) : !items || items.length === 0 ? (
          <>
            <p className="text-xs text-muted-foreground">{emptyLabel}</p>
            <p className="text-xs text-muted-foreground">
              <Link to="/skills">{t("editor.goToPackages")}</Link>
            </p>
          </>
        ) : (
          <div className="flex flex-col gap-1">
            {items.map((item) => {
              const isSelected = selectedMap.has(item.id);
              const isBuiltIn = item.source === "system";
              const entry = selectedMap.get(item.id);

              return (
                <label
                  key={item.id}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md border border-border px-3 py-2 cursor-pointer transition-colors hover:bg-muted/50",
                    isSelected && "border-primary bg-primary/5",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggle(item.id)}
                    className="w-3.5 h-3.5 rounded"
                  />
                  <div className="flex flex-col min-w-0 flex-1">
                    <span className="text-sm font-medium truncate">{item.name || item.id}</span>
                    {item.description && (
                      <span className="text-xs text-muted-foreground truncate">
                        {item.description}
                      </span>
                    )}
                  </div>
                  {isSelected && (
                    <div className="ml-auto shrink-0">
                      {isBuiltIn ? (
                        <span className="inline-block rounded bg-muted px-2 py-0.5 text-xs font-mono text-muted-foreground">
                          {t("editor.builtIn", "Integree")}
                        </span>
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
