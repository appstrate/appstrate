// SPDX-License-Identifier: Apache-2.0

import { type ChangeEvent, useMemo, useEffect, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { SectionCard } from "../section-card";
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
import { Checkbox } from "@/components/ui/checkbox";
import { ShieldCheck } from "lucide-react";
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
      <span className="bg-muted text-muted-foreground inline-block rounded px-2 py-0.5 font-mono text-xs">
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
      toast.error(err instanceof Error ? err.message : t("error.unknown"));
    }

    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const uploadButton = (
    <label className="border-border text-foreground hover:bg-muted inline-flex cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs font-medium tracking-normal normal-case transition-colors">
      {upload.isPending ? <Spinner /> : t("editor.importZip")}
      <input
        type="file"
        accept=".afps"
        ref={fileInputRef}
        onChange={handleUpload}
        className="hidden"
        disabled={upload.isPending}
      />
    </label>
  );

  return (
    <SectionCard title={title} headerRight={uploadButton}>
      {isLoading ? (
        <div className="text-muted-foreground flex items-center justify-center py-6">
          <Spinner />
        </div>
      ) : !items || items.length === 0 ? (
        <>
          <p className="text-muted-foreground text-xs">{emptyLabel}</p>
          <p className="text-muted-foreground text-xs">
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
                  "border-border hover:bg-muted/50 flex cursor-pointer items-center gap-2.5 rounded-md border px-3 py-2 transition-colors",
                  isSelected && "border-primary bg-primary/5",
                )}
              >
                <Checkbox checked={isSelected} onCheckedChange={() => toggle(item.id)} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {item.name || item.id}
                    {isBuiltIn && (
                      <ShieldCheck className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                    )}
                  </span>
                  {item.description && (
                    <span className="text-muted-foreground truncate text-xs">
                      {item.description}
                    </span>
                  )}
                </div>
                {isSelected && (
                  <div className="ml-auto shrink-0">
                    {isBuiltIn ? (
                      <span className="bg-muted text-muted-foreground inline-block rounded px-2 py-0.5 font-mono text-xs">
                        {t("editor.builtIn")}
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
    </SectionCard>
  );
}
