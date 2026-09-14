// SPDX-License-Identifier: Apache-2.0

import { type ChangeEvent, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
import { SectionCard } from "../section-card";
import { packageDetailPath, packageListPath } from "../../lib/package-paths";
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
import { Button } from "@appstrate/ui/components/button";
import { ShieldCheck, AlertTriangle, ArrowUpRight, Plus, SearchX, Trash2 } from "lucide-react";
import { Spinner } from "../spinner";
import { ListToolbar } from "../list-toolbar";
import { Badge } from "@appstrate/ui/components/badge";
import { ErrorState, EmptyState } from "../page-states";
import { useActivateIntegration } from "../../hooks/use-integrations";
import type { ResourceEntry } from "./types";
import { caretRange } from "./utils";
import { IntegrationToolPicker } from "./integration-tool-picker";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { TableRowActions } from "../table-row-actions";
import { Modal } from "../modal";
import { useModalParam } from "../../hooks/use-modal-param";

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
  surface?: "card" | "settings";
}

function VersionSelect({
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
  const { t } = useTranslation("agents");
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
        {value || "*"}
      </span>
    );
  }

  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger
        aria-label={t("editor.resourceVersion", { name: packageId })}
        className="h-8 w-[100px] text-xs"
        onClick={(e) => e.stopPropagation()}
      >
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
  surface = "card",
}: ResourceSectionProps) {
  const { t } = useTranslation(["agents", "common"]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const resourceId = useId();
  const [search, setSearch] = useState("");
  const [selection, setSelection] = useState<string[]>([]);
  // Integrations must be active (installed + enabled) in this app to be
  // usable. Filter server-side (`?active=true`) so the editor never pulls the
  // full catalogue — only active integrations are offered.
  const {
    data: items,
    isLoading,
    error,
  } = usePackageList(type, {
    activeOnly: type === "integration",
  });
  const upload = useUploadPackage(type);
  const activate = useActivateIntegration();

  const selectedMap = new Map(selectedEntries.map((e) => [e.id, e]));

  // A declared dependency the catalog does not return: an integration that is no
  // longer active here (uninstalled/disabled since), or a skill that is simply
  // not installed. Either way it must stay VISIBLE — it is in the manifest and
  // the run-time gate will reject it (`integration_not_active` /
  // `missing_skill`), so hiding it makes the editor claim the agent declares
  // less than it does. This used to be integration-only, which is how a declared
  // skill missing from the catalogue rendered as "no skill at all".
  // Ids declared when the editor opened. Kept because the flagged rows below are
  // derived from what is CURRENTLY selected: unchecking one removed it from that
  // set, so the row vanished from the screen entirely and the only way back was
  // to cancel the whole edit. Anchoring on the opening state keeps the row in
  // place with its box unticked, which is what "I can undo this" looks like.
  const [declaredOnOpen] = useState(() => selectedEntries);

  const inactiveDeclaredIds = useMemo(() => {
    if (!items) return [];
    const present = new Set(items.map((i) => i.id));
    const declared = new Set([
      ...declaredOnOpen.map((e) => e.id),
      ...selectedEntries.map((e) => e.id),
    ]);
    return [...declared].filter((id) => !present.has(id));
  }, [items, selectedEntries, declaredOnOpen]);

  const toggle = (id: string) => {
    onChange((prev) => {
      if (prev.some((e) => e.id === id)) {
        return prev.filter((e) => e.id !== id);
      }
      const item = items?.find((i) => i.id === id);
      if (item?.version) return [...prev, { id, version: caretRange(item.version) }];
      // Not in the catalogue, so there is no version to read: this is a
      // declared-but-missing dependency being re-checked after an unintended
      // uncheck. Restore the entry exactly as the manifest had it — without this
      // the box could be emptied but never refilled.
      const original = declaredOnOpen.find((e) => e.id === id);
      return original ? [...prev, original] : prev;
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

  const matchesFilter = (id: string, name = "", description = "") => {
    const needle = search.trim().toLocaleLowerCase();
    return (
      `${id} ${name} ${description}`.toLocaleLowerCase().includes(needle) &&
      (selection.length === 0 || selection.includes(selectedMap.has(id) ? "selected" : "available"))
    );
  };
  const visibleItems = (items ?? []).filter((item) =>
    matchesFilter(item.id, item.name ?? "", item.description ?? ""),
  );
  const visibleMissingIds = inactiveDeclaredIds.filter((id) => matchesFilter(id));

  const toolbar = (
    <ListToolbar
      placement="panel"
      panelFiltersAdjacent
      search={{ value: search, onChange: setSearch, placeholder: t("editor.resourceSearch") }}
      filters={[
        {
          id: "selection",
          label: t("editor.resourceSelection"),
          values: selection,
          options: [
            { value: "selected", label: t("editor.resourceSelected") },
            { value: "available", label: t("editor.resourceAvailable") },
          ],
          onChange: setSelection,
        },
      ]}
      actions={uploadButton}
      onReset={() => {
        setSearch("");
        setSelection([]);
      }}
    />
  );

  const content = (
    <>
      {error ? (
        <ErrorState message={String(error)} compact />
      ) : isLoading ? (
        <div className="text-muted-foreground flex items-center justify-center py-6">
          <Spinner />
        </div>
      ) : (!items || items.length === 0) && inactiveDeclaredIds.length === 0 && !leadingItems ? (
        <>
          <p className="text-muted-foreground text-xs">{emptyLabel}</p>
          <p className="text-muted-foreground text-xs">
            <Link to={packageListPath(type)}>{t("editor.goToPackages")}</Link>
          </p>
        </>
      ) : (
        <div className="border-border flex flex-col border-t">
          {leadingItems}
          {visibleItems.map((item) => {
            const isSelected = selectedMap.has(item.id);
            const isBuiltIn = item.source === "system";
            const entry = selectedMap.get(item.id);

            return (
              <div
                key={item.id}
                className={cn(
                  "border-border border-b transition-colors",
                  isSelected && "bg-muted/10",
                )}
              >
                <div className="hover:bg-muted/30 flex items-center gap-2.5 py-4">
                  <Checkbox
                    id={`${resourceId}-${item.id}`}
                    checked={isSelected}
                    onCheckedChange={() => toggle(item.id)}
                  />
                  <label
                    htmlFor={`${resourceId}-${item.id}`}
                    className="flex min-w-0 flex-1 cursor-pointer flex-col"
                  >
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
                  </label>
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
                  <Button asChild variant="ghost" size="icon" className="size-8 shrink-0">
                    <Link
                      to={packageDetailPath(type, item.id)}
                      target="_blank"
                      rel="noopener noreferrer"
                      aria-label={t("editor.resourceOpen", { name: item.name || item.id })}
                    >
                      <ArrowUpRight className="size-4" />
                    </Link>
                  </Button>
                </div>
                {isSelected && type === "integration" && entry && (
                  <div className="pb-4">
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

          {/* Declared but not usable here: an integration that is not active in
              this space, or a skill that is not installed. Flagged rather
              than hidden, because the run gate rejects them.

              For an integration the row also carries the cure. The message says
              "activate it to connect it", and until now nothing on this screen
              could: the checkbox only removes the dependency. So the one action
              the sentence asks for had no button anywhere. */}
          {visibleItems.length === 0 && visibleMissingIds.length === 0 && !leadingItems && (
            <EmptyState icon={SearchX} message={t("editor.resourceNoMatch")} compact />
          )}
          {visibleMissingIds.map((id) => (
            <div
              key={id}
              className="border-destructive/40 bg-destructive/5 flex flex-wrap items-center gap-2 border-b pr-2"
            >
              <label className="flex flex-1 cursor-pointer items-center gap-2.5 px-3 py-2">
                <Checkbox checked={selectedMap.has(id)} onCheckedChange={() => toggle(id)} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                    {id}
                    <span className="text-destructive inline-flex items-center gap-1 text-xs font-normal">
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                      {type === "integration"
                        ? t("editor.integrationInactive")
                        : t("editor.dependencyMissing")}
                    </span>
                  </span>
                </div>
              </label>
              {type === "integration" && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={activate.isPending}
                  onClick={() => activate.mutate({ params: { path: { packageId: id } } })}
                >
                  {activate.isPending ? <Spinner /> : t("editor.activateIntegration")}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );

  if (surface === "settings") {
    return (
      <SelectedResources
        type={type}
        title={title}
        emptyLabel={emptyLabel}
        items={items}
        isLoading={isLoading}
        error={error}
        selectedEntries={selectedEntries}
        missingIds={inactiveDeclaredIds}
        uploadButton={uploadButton}
        onToggle={toggle}
        onVersion={updateVersion}
        onReplace={replaceEntry}
        onAdd={(ids) =>
          onChange((prev) => [
            ...prev,
            ...ids
              .filter((id) => !prev.some((e) => e.id === id))
              .map((id) => {
                const item = items?.find((i) => i.id === id);
                return { id, version: item?.version ? caretRange(item.version) : "*" };
              }),
          ])
        }
        onActivate={(id) => activate.mutate({ params: { path: { packageId: id } } })}
        activating={activate.isPending}
      />
    );
  }

  return (
    <SectionCard title={title}>
      {toolbar}
      {content}
    </SectionCard>
  );
}

type CatalogItem = NonNullable<ReturnType<typeof usePackageList>["data"]>[number];

/**
 * The Définition's view of an agent's skills or integrations: ONLY what the
 * agent uses, as rows, and "Ajouter" to pick more.
 *
 * The page editor lists the whole catalogue with a box per item, which stops
 * reading once an organisation has twenty skills: what the agent actually uses
 * drowns in what it could. Here the rows are the dependencies, each with its
 * version, its tools for an integration, and a "…" menu to open or remove it;
 * the catalogue is a modal, opened on purpose.
 */
function SelectedResources({
  type,
  title,
  emptyLabel,
  items,
  isLoading,
  error,
  selectedEntries,
  missingIds,
  uploadButton,
  onToggle,
  onVersion,
  onReplace,
  onAdd,
  onActivate,
  activating,
}: {
  type: PackageType;
  title: string;
  emptyLabel: string;
  items: CatalogItem[] | undefined;
  isLoading: boolean;
  error: unknown;
  selectedEntries: ResourceEntry[];
  missingIds: string[];
  uploadButton: ReactNode;
  onToggle: (id: string) => void;
  onVersion: (id: string, version: string) => void;
  onReplace: (id: string, next: ResourceEntry) => void;
  onAdd: (ids: string[]) => void;
  onActivate: (id: string) => void;
  activating: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const picker = useModalParam("add");
  const byId = new Map((items ?? []).map((item) => [item.id, item] as const));
  const missing = new Set(missingIds);
  const rows = selectedEntries;

  return (
    <section aria-label={title} className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Badge variant="secondary">{rows.length}</Badge>
        </div>
        <div className="flex items-center gap-2">
          {uploadButton}
          <Button type="button" size="sm" onClick={() => picker.open()}>
            <Plus />
            {t("editor.resourceAdd")}
          </Button>
        </div>
      </div>

      {error ? (
        <ErrorState message={String(error)} compact />
      ) : isLoading ? (
        <div className="text-muted-foreground flex items-center justify-center py-6">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <EmptyState message={emptyLabel} icon={SearchX} compact />
      ) : (
        <div className="border-border divide-border divide-y rounded-lg border">
          {rows.map((entry) => {
            const item = byId.get(entry.id);
            const isMissing = missing.has(entry.id);
            return (
              <div key={entry.id} className={cn("px-4 py-3", isMissing && "bg-destructive/5")}>
                <div className="flex items-center gap-3">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                      {item?.name || entry.id}
                      {item?.source === "system" && (
                        <ShieldCheck className="text-muted-foreground size-3.5 shrink-0" />
                      )}
                    </span>
                    {isMissing ? (
                      <span className="text-destructive inline-flex items-center gap-1 text-xs">
                        <AlertTriangle className="size-3.5 shrink-0" />
                        {type === "integration"
                          ? t("editor.integrationInactive")
                          : t("editor.dependencyMissing")}
                      </span>
                    ) : (
                      item?.description && (
                        <span className="text-muted-foreground truncate text-xs">
                          {item.description}
                        </span>
                      )
                    )}
                  </div>
                  {isMissing && type === "integration" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={activating}
                      onClick={() => onActivate(entry.id)}
                    >
                      {activating ? <Spinner /> : t("editor.activateIntegration")}
                    </Button>
                  )}
                  {!isMissing && (
                    <VersionSelect
                      type={type}
                      packageId={entry.id}
                      value={entry.version ?? "*"}
                      onChange={(v) => onVersion(entry.id, v)}
                    />
                  )}
                  <TableRowActions
                    menuLabel={t("editor.resourceActions", { name: item?.name || entry.id })}
                  >
                    <DropdownMenuItem asChild>
                      <Link
                        to={packageDetailPath(type, entry.id)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <ArrowUpRight />
                        {t("editor.resourceOpen", { name: item?.name || entry.id })}
                      </Link>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => onToggle(entry.id)}
                      className="text-destructive focus:text-destructive"
                    >
                      <Trash2 />
                      {t("editor.resourceRemove")}
                    </DropdownMenuItem>
                  </TableRowActions>
                </div>
                {type === "integration" && !isMissing && (
                  <div className="pt-3">
                    <IntegrationToolPicker
                      packageId={entry.id}
                      entry={entry}
                      onChange={(next) => onReplace(entry.id, next)}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {picker.value !== null && (
        <ResourcePicker
          title={t("editor.resourceAddTitle", { kind: title })}
          items={(items ?? []).filter((item) => !selectedEntries.some((e) => e.id === item.id))}
          onClose={picker.close}
          onAdd={(ids) => {
            onAdd(ids);
            picker.close();
          }}
        />
      )}
    </section>
  );
}

/** The catalogue of what can be added, searched and ticked, in a modal. */
function ResourcePicker({
  title,
  items,
  onClose,
  onAdd,
}: {
  title: string;
  items: CatalogItem[];
  onClose: () => void;
  onAdd: (ids: string[]) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const [search, setSearch] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const needle = search.trim().toLocaleLowerCase();
  const shown = items.filter((item) =>
    `${item.id} ${item.name ?? ""} ${item.description ?? ""}`.toLocaleLowerCase().includes(needle),
  );

  return (
    <Modal
      open
      onClose={onClose}
      title={title}
      className="sm:max-w-2xl"
      actions={
        <Button type="button" disabled={picked.length === 0} onClick={() => onAdd(picked)}>
          {t("editor.resourceAddSelection", { count: picked.length })}
        </Button>
      }
    >
      <ListToolbar
        placement="panel"
        search={{ value: search, onChange: setSearch, placeholder: t("editor.resourceSearch") }}
        filters={[]}
      />
      <div className="border-border max-h-[50dvh] divide-y overflow-y-auto rounded-lg border">
        {shown.length === 0 ? (
          <EmptyState icon={SearchX} message={t("editor.resourceNoMatch")} compact />
        ) : (
          shown.map((item) => (
            <label
              key={item.id}
              className="hover:bg-muted/30 flex cursor-pointer items-center gap-3 px-4 py-3"
            >
              <Checkbox
                checked={picked.includes(item.id)}
                onCheckedChange={() =>
                  setPicked((prev) =>
                    prev.includes(item.id)
                      ? prev.filter((id) => id !== item.id)
                      : [...prev, item.id],
                  )
                }
              />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                  {item.name || item.id}
                  {item.source === "system" && (
                    <ShieldCheck className="text-muted-foreground size-3.5 shrink-0" />
                  )}
                </span>
                {item.description && (
                  <span className="text-muted-foreground truncate text-xs">{item.description}</span>
                )}
              </span>
            </label>
          ))
        )}
      </div>
    </Modal>
  );
}
