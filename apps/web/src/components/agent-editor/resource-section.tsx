// SPDX-License-Identifier: Apache-2.0

import { type ChangeEvent, type ReactNode, useMemo, useRef } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
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
} from "@appstrate/ui/components/select";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { ShieldCheck, AlertTriangle } from "lucide-react";
import { Spinner } from "../spinner";
import type { ResourceEntry } from "./types";
import { caretRange } from "./utils";
import { IntegrationToolPicker } from "./integration-tool-picker";

type ResourceEntriesUpdater = ResourceEntry[] | ((prev: ResourceEntry[]) => ResourceEntry[]);

interface ResourceSectionProps {
  type: PackageType;
  title: string;
  emptyLabel: string;
  selectedEntries: ResourceEntry[];
  onChange: (updater: ResourceEntriesUpdater) => void;
  /**
   * Extra entries rendered at the top of the list, before the catalog
   * items — same visual chrome, different data source. Used to surface
   * the platform runtime tools as a system "integration" card in the
   * Integrations section. When present, the empty state is suppressed
   * (the list always renders so the leading items show).
   */
  leadingItems?: ReactNode;
}

export function VersionSelect({
  type,
  packageId,
  value,
  onChange,
}: {
  type: PackageType | "agent";
  packageId: string;
  value: string;
  onChange: (version: string) => void;
}) {
  const { data: versions, isLoading } = usePackageVersions(type, packageId);
  const available = useMemo(() => versions?.filter((v) => !v.yanked), [versions]);
  const ranges = useMemo(() => available?.map((v) => caretRange(v.version)) ?? [], [available]);

  // A stored value outside the offered caret ranges (exact pin typed by
  // hand, yanked version pinned in the manifest, etc.) is rendered as its
  // own option instead of being silently rewritten to caret-of-latest:
  // the pin is the operator's intent and opening the editor must never
  // mutate the draft. Picking a listed range replaces it explicitly.
  const outOfListValue = value && !ranges.includes(value) ? value : null;

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
      <SelectTrigger className="h-7 w-[100px] text-xs" onClick={(e) => e.stopPropagation()}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {outOfListValue && <SelectItem value={outOfListValue}>{outOfListValue}</SelectItem>}
        {available.map((v) => (
          <SelectItem key={v.id} value={caretRange(v.version)}>
            {caretRange(v.version)}
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
  leadingItems,
}: ResourceSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Integrations must be active (installed + enabled) in this app to be
  // usable. Filter server-side (`?active=true`) so the editor never pulls the
  // full catalogue — only active integrations are offered.
  const { data: items, isLoading } = usePackageList(type, {
    activeOnly: type === "integration",
  });
  const upload = useUploadPackage(type);

  const selectedMap = new Map(selectedEntries.map((e) => [e.id, e]));

  // An agent may still declare an integration that's no longer active here
  // (uninstalled/disabled since). Those won't come back in the active list, so
  // surface them in a flagged section — never silently drop a declared
  // dependency (the run-time gate would reject it with `integration_not_active`).
  const inactiveDeclaredIds = useMemo(() => {
    if (type !== "integration" || !items) return [];
    const present = new Set(items.map((i) => i.id));
    return selectedEntries.filter((e) => !present.has(e.id)).map((e) => e.id);
  }, [items, type, selectedEntries]);

  const toggle = (id: string) => {
    onChange((prev) => {
      if (prev.some((e) => e.id === id)) {
        return prev.filter((e) => e.id !== id);
      }
      const item = items?.find((i) => i.id === id);
      if (!item?.version) return prev;
      return [...prev, { id, version: caretRange(item.version) }];
    });
  };

  const updateVersion = (id: string, version: string) => {
    onChange((prev) => prev.map((e) => (e.id === id ? { ...e, version } : e)));
  };

  const replaceEntry = (id: string, next: ResourceEntry) => {
    onChange((prev) => prev.map((e) => (e.id === id ? next : e)));
  };

  const handleUpload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      const result = await upload.mutateAsync(file);
      const newId = result.id;
      const newVersion = result.version;
      if (!newVersion) return;

      onChange((prev) => {
        if (prev.some((e) => e.id === newId)) return prev;
        return [...prev, { id: newId, version: caretRange(newVersion) }];
      });
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
      ) : (!items || items.length === 0) && inactiveDeclaredIds.length === 0 && !leadingItems ? (
        <>
          <p className="text-muted-foreground text-xs">{emptyLabel}</p>
          <p className="text-muted-foreground text-xs">
            <Link to="/skills">{t("editor.goToPackages")}</Link>
          </p>
        </>
      ) : (
        <div className="flex flex-col gap-1">
          {leadingItems}
          {(items ?? []).map((item) => {
            const isSelected = selectedMap.has(item.id);
            const isBuiltIn = item.source === "system";
            const entry = selectedMap.get(item.id);

            return (
              <div
                key={item.id}
                className={cn(
                  "border-border rounded-md border transition-colors",
                  isSelected && "border-primary bg-primary/5",
                )}
              >
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-2.5 px-3 py-2",
                    !isSelected && "hover:bg-muted/50 rounded-md",
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
                      <VersionSelect
                        type={type}
                        packageId={item.id}
                        value={entry?.version ?? "*"}
                        onChange={(v) => updateVersion(item.id, v)}
                      />
                    </div>
                  )}
                </label>
                {isSelected && type === "integration" && entry && (
                  <div className="px-3 pb-3">
                    <IntegrationToolPicker
                      packageId={item.id}
                      entry={entry}
                      onChange={(next) => replaceEntry(item.id, next)}
                    />
                  </div>
                )}
              </div>
            );
          })}

          {/* Declared but no longer active in this app — flagged so the user
              can drop them (or an admin can re-activate). Uncheck removes the
              dependency from the manifest. */}
          {inactiveDeclaredIds.map((id) => (
            <div key={id} className="border-destructive/40 bg-destructive/5 rounded-md border">
              <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2">
                <Checkbox checked onCheckedChange={() => toggle(id)} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {id}
                    <span className="text-destructive inline-flex items-center gap-1 text-xs font-normal">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      {t("editor.integrationInactive")}
                    </span>
                  </span>
                </div>
              </label>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
