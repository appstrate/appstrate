// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { cn } from "@appstrate/ui/cn";
import { ActivateIntegrationButton } from "../activate-integration-button";
import { PackageVersionSelect } from "../package-version-select";
import { packageDetailPath } from "../../lib/package-paths";
import { matchesSearch } from "../../lib/strings";
import { useLocalListParams } from "../../lib/list-params";
import { usePackageList, type PackageType } from "../../hooks/use-packages";
import type { ImportedPackage } from "../../hooks/use-mutations";
import { ImportModal } from "../import-modal";
import { Checkbox } from "@appstrate/ui/components/checkbox";
import { Button } from "@appstrate/ui/components/button";
import {
  ShieldCheck,
  AlertTriangle,
  ArrowUpRight,
  Plus,
  SearchX,
  Trash2,
  Upload,
  Wrench,
} from "lucide-react";
import { ListToolbar } from "../list-toolbar";
import { Badge } from "@appstrate/ui/components/badge";
import { ErrorState, EmptyState, EmptyStateAction, NoMatchState } from "../page-states";
import type { ResourceEntry } from "./types";
import { caretRange, isPlatformEntry } from "./utils";
import { IntegrationToolPicker } from "./integration-tool-picker";
import { DropdownMenuItem } from "@appstrate/ui/components/dropdown-menu";
import { TableRowActions } from "../table-row-actions";
import { FormModal } from "../form-modal";
import { Modal } from "../modal";
import { PageActionsMenu } from "../page-actions-menu";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@appstrate/ui/components/table";
import { rowSpace } from "../../lib/across-spaces";
import { useCurrentSpaceId, useSpaceLink } from "../../hooks/use-current-space";
import { deedEntry, deedInSpaces, spaceDeedLabels } from "../space-deed";
import { useOverviewMode } from "../../hooks/use-overview-mode";
import { useSpacesFor } from "../../hooks/use-space-action";
import { packagePermission } from "@appstrate/core/permissions";
import { TextSkeleton } from "../loading-skeletons";

type CatalogItem = NonNullable<ReturnType<typeof usePackageList>["data"]>[number];

/**
 * An agent's skills or integrations: ONLY what the agent uses, in a table, and
 * the list's one "Actions" menu to add or import.
 *
 * The rows are the dependencies — stock shadcn `Table` — each with its version
 * and, for an integration, the tools it allows summed up in one line; changing
 * those opens a modal, from the row's "…" menu. Adding opens the catalogue in a
 * modal too.
 */
export function ResourceSection({
  type,
  title,
  emptyLabel,
  selectedEntries,
  onChange,
  toolPolicySpaceId,
}: {
  type: PackageType;
  title: string;
  emptyLabel: string;
  selectedEntries: ResourceEntry[];
  onChange: (update: (prev: ResourceEntry[]) => ResourceEntry[]) => void;
  /**
   * The agent's home space: its approvals and blocks are the ones a save judges against. Used
   * where the integration is placed there; elsewhere the row's own space reads it.
   */
  toolPolicySpaceId: string | null;
}) {
  const { t } = useTranslation(["agents", "settings", "common"]);
  // The picker offers the index, what the working space runs (in « Tous les espaces », any space
  // the reader reaches: the definition is the same everywhere). A declared dependency resolves
  // org-wide (RBAC §6.9), so one outside the index stays listed below.
  const { on: spanning } = useOverviewMode();
  const { data: items, isLoading, error } = usePackageList(type, spanning);
  // Without the type's read the catalog never loads: the declared
  // entries are then all this section knows, listed by id.
  const canReadCatalog = useSpacesFor({ permission: packagePermission(type, "read") }).offered;
  const catalogUnreadable = t(
    spanning ? "editor.catalogUnreadableAcross" : "editor.catalogUnreadable",
  );
  const workingSpaceId = useCurrentSpaceId();
  const linkInSpace = useSpaceLink();
  const readSpace = (item: CatalogItem | undefined) =>
    spanning ? rowSpace(item?.space_ids, workingSpaceId) : undefined;
  const writers = useSpacesFor({ permission: packagePermission(type, "write") });
  const [importSpaceId, setImportSpaceId] = useState<string | null>(null);
  const importDeed = deedInSpaces(
    spanning,
    writers.targets,
    spaceDeedLabels(t, "spaceChoice.import", "spaceChoice.importIn"),
    setImportSpaceId,
  );
  const [picking, setPicking] = useState(false);
  const [toolsId, setToolsId] = useState<string | null>(null);
  const toolsEntry = selectedEntries.find((entry) => entry.id === toolsId);
  const isIntegration = type === "integration";

  // A declared dependency the catalog does not return: an integration that is no
  // longer active here (switched off since), or a skill that is simply not
  // placed here. Either way it must stay VISIBLE — it is in the manifest and
  // the run-time gate will reject it (`integration_not_active` /
  // `missing_skill`), so hiding it makes the editor claim the agent declares
  // less than it does.
  const missing = useMemo(() => {
    if (canReadCatalog && !items) return new Set<string>();
    const present = new Set((items ?? []).map((i) => i.id));
    return new Set(selectedEntries.map((e) => e.id).filter((id) => !present.has(id)));
  }, [canReadCatalog, items, selectedEntries]);
  const byId = new Map((items ?? []).map((item) => [item.id, item] as const));
  // A read of a package in a space it is not placed in is a 404: the policy's space only serves a
  // row that proves it carries it.
  const toolsItem = toolsEntry ? byId.get(toolsEntry.id) : undefined;
  const toolsSpaceId = toolsEntry
    ? toolPolicySpaceId && toolsItem?.space_ids?.includes(toolPolicySpaceId)
      ? toolPolicySpaceId
      : readSpace(toolsItem)
    : undefined;

  const updateVersion = (id: string, version: string) =>
    onChange((prev) => prev.map((e) => (e.id === id ? { ...e, version } : e)));

  const replaceEntry = (id: string, next: ResourceEntry) =>
    onChange((prev) => prev.map((e) => (e.id === id ? next : e)));

  const remove = (id: string) => onChange((prev) => prev.filter((e) => e.id !== id));

  const add = (ids: string[]) =>
    onChange((prev) => [
      ...prev,
      ...ids
        .filter((id) => !prev.some((e) => e.id === id))
        .map((id) => {
          const item = byId.get(id);
          return { id, version: item?.version ? caretRange(item.version) : "*" };
        }),
    ]);

  /** An imported package becomes a dependency, pinned to the version it was imported at. */
  const addImported = ({ packageId, version }: ImportedPackage) => {
    if (!version) return;
    onChange((prev) =>
      prev.some((e) => e.id === packageId)
        ? prev
        : [...prev, { id: packageId, version: caretRange(version) }],
    );
  };

  const toolsSummary = (entry: ResourceEntry) =>
    entry.tools === undefined
      ? t("editor.toolsDefault")
      : entry.tools === "*"
        ? t("editor.toolsAll")
        : entry.tools.length === 0
          ? t("editor.toolsNone")
          : entry.tools.join(", ");

  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-semibold">{title}</h3>
          <Badge variant="secondary">{selectedEntries.length}</Badge>
        </div>
        <PageActionsMenu
          actions={[
            {
              id: "add",
              label: t("common:btn.add"),
              icon: Plus,
              onSelect: () => setPicking(true),
              disabled: !canReadCatalog,
            },
            {
              id: "import",
              label: t("common:nav.import"),
              icon: Upload,
              ...deedEntry(importDeed),
            },
          ]}
        />
      </div>

      {error ? (
        <ErrorState error={error} compact />
      ) : isLoading ? (
        <TextSkeleton className="py-2" />
      ) : selectedEntries.length === 0 ? (
        <EmptyState
          message={canReadCatalog ? emptyLabel : catalogUnreadable}
          icon={SearchX}
          compact
        >
          {canReadCatalog && (
            <EmptyStateAction
              action={{ label: t("common:btn.add"), onSelect: () => setPicking(true) }}
            />
          )}
        </EmptyState>
      ) : (
        <div className="border-border overflow-hidden rounded-lg border">
          {!canReadCatalog && (
            <p className="text-muted-foreground border-border border-b px-4 py-3 text-xs">
              {catalogUnreadable}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("list.column.name")}</TableHead>
                <TableHead className="w-32">{t("run.infoVersion")}</TableHead>
                {isIntegration && <TableHead>{t("editor.resourceTools")}</TableHead>}
                <TableHead className="w-12" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {selectedEntries.map((entry) => {
                const item = byId.get(entry.id);
                const isMissing = missing.has(entry.id);
                // Unlisted because the catalog is unreadable, not because it is inactive here.
                const flagged = isMissing && canReadCatalog;
                const name = item?.name || entry.id;
                return (
                  <TableRow key={entry.id} className={cn(flagged && "bg-destructive/5")}>
                    <TableCell>
                      <div className="flex min-w-0 flex-col">
                        <span className="flex items-center gap-1.5 truncate text-sm font-medium">
                          {name}
                          {item?.source === "system" && (
                            <ShieldCheck className="text-muted-foreground size-3.5 shrink-0" />
                          )}
                        </span>
                        {flagged ? (
                          <span className="text-destructive inline-flex items-center gap-1 text-xs">
                            <AlertTriangle className="size-3.5 shrink-0" />
                            {t(
                              isIntegration
                                ? spanning
                                  ? "editor.integrationInactiveAcross"
                                  : "editor.integrationInactive"
                                : spanning
                                  ? "editor.dependencyMissingAcross"
                                  : "editor.dependencyMissing",
                            )}
                          </span>
                        ) : (
                          item?.description && (
                            <span className="text-muted-foreground max-w-[24rem] truncate text-xs">
                              {item.description}
                            </span>
                          )
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      {isMissing ? (
                        !flagged ? (
                          <span className="text-muted-foreground font-mono text-xs">
                            {entry.version ?? "*"}
                          </span>
                        ) : (
                          // It switches it on in the working space, which the mode does not name.
                          isIntegration &&
                          !spanning && <ActivateIntegrationButton packageId={entry.id} />
                        )
                      ) : (
                        <PackageVersionSelect
                          type={type}
                          packageId={entry.id}
                          spaceId={readSpace(item)}
                          value={entry.version ?? "*"}
                          onChange={(v) => updateVersion(entry.id, v)}
                          toOption={(version) => ({
                            value: caretRange(version),
                            label: caretRange(version),
                          })}
                          className="h-8 w-[100px] text-xs"
                          aria-label={t("editor.resourceVersion", { name: entry.id })}
                        />
                      )}
                    </TableCell>
                    {isIntegration && (
                      <TableCell className="text-muted-foreground max-w-[20rem] truncate text-sm">
                        {isMissing ? "—" : toolsSummary(entry)}
                      </TableCell>
                    )}
                    <TableCell className="text-right">
                      <TableRowActions
                        menuLabel={t("editor.rowActions", { name })}
                        actions={[
                          {
                            id: "tools",
                            label: t("editor.toolsEdit"),
                            icon: Wrench,
                            onSelect: () => setToolsId(entry.id),
                            hidden: !isIntegration || isMissing,
                          },
                          {
                            id: "remove",
                            label: t("common:btn.remove"),
                            icon: Trash2,
                            onSelect: () => remove(entry.id),
                            destructive: true,
                            hidden: isPlatformEntry(entry),
                          },
                        ]}
                      >
                        <DropdownMenuItem asChild>
                          <Link
                            to={linkInSpace(packageDetailPath(type, entry.id), readSpace(item))}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ArrowUpRight />
                            {t("editor.resourceOpen", { name })}
                          </Link>
                        </DropdownMenuItem>
                      </TableRowActions>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {importSpaceId && (
        <ImportModal
          spaceId={importSpaceId}
          type={type}
          onClose={() => setImportSpaceId(null)}
          onImported={addImported}
        />
      )}
      {picking && (
        <ResourcePicker
          title={t("editor.resourceAddTitle", { kind: title })}
          items={(items ?? []).filter((item) => !selectedEntries.some((e) => e.id === item.id))}
          onClose={() => setPicking(false)}
          onAdd={(ids) => {
            add(ids);
            setPicking(false);
          }}
        />
      )}

      {toolsEntry && (
        <ToolsModal
          name={byId.get(toolsEntry.id)?.name || toolsEntry.id}
          entry={toolsEntry}
          spaceId={toolsSpaceId}
          onClose={() => setToolsId(null)}
          onApply={(next) => {
            replaceEntry(toolsEntry.id, next);
            setToolsId(null);
          }}
        />
      )}
    </section>
  );
}

/** An integration's allowed tools, edited on a copy and applied to the draft. */
function ToolsModal({
  name,
  spaceId,
  entry,
  onClose,
  onApply,
}: {
  name: string;
  spaceId?: string;
  entry: ResourceEntry;
  onClose: () => void;
  onApply: (entry: ResourceEntry) => void;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const [draft, setDraft] = useState(entry);
  return (
    <FormModal
      title={t("editor.toolsTitle", { name })}
      onClose={onClose}
      onSubmit={(event) => {
        event.preventDefault();
        onApply(draft);
      }}
      submitLabel={t("editor.apply")}
      className="sm:max-w-2xl"
    >
      <div className="max-h-[60dvh] overflow-y-auto">
        <IntegrationToolPicker
          spaceId={spaceId}
          packageId={entry.id}
          entry={draft}
          onChange={setDraft}
        />
      </div>
    </FormModal>
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
  const list = useLocalListParams();
  const [picked, setPicked] = useState<string[]>([]);
  const shown = items.filter((item) =>
    matchesSearch(list.search, [item.id, item.name, item.description]),
  );

  return (
    <Modal
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
        search={{
          value: list.search,
          onChange: list.setSearch,
          placeholder: t("editor.resourceSearch"),
        }}
      />
      <div className="border-border max-h-[50dvh] divide-y overflow-y-auto rounded-lg border">
        {shown.length === 0 ? (
          <NoMatchState message={t("editor.resourceNoMatch")} onReset={list.reset} />
        ) : (
          shown.map((item) => (
            <label
              key={item.id}
              className="hover:bg-muted/50 flex cursor-pointer items-center gap-3 px-4 py-3"
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
