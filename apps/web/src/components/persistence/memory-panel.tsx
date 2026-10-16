// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit } from "lucide-react";
import { EmptyState, NoMatchState } from "../page-states";
import { ActorBadge } from "./actor-badge";
import { useMemoryColumns, type MemoryCollectionItem } from "./memory-columns";
import { DataTable } from "../data-table";
import { ListToolbar, type FilterSpec } from "../list-toolbar";
import { useLocalListParams } from "../../lib/list-params";
import { Modal } from "../modal";
import { ConfirmModal } from "../confirm-modal";
import { formatDateField } from "../../lib/format-date";
import { filterMemoryItems, memoryText } from "../../lib/memory-items";
import { useCopyToClipboard } from "@appstrate/ui/use-copy-to-clipboard";
import { useUrlModalTarget } from "../../hooks/use-url-modal";
import {
  useAgentMemories,
  useAgentPinned,
  useDeletePinnedSlot,
  useRunMemories,
  useRunPinned,
} from "../../hooks/use-persistence";
import { useDeleteMemory } from "../../hooks/use-mutations";
import { usePermissions } from "../../hooks/use-permissions";

interface MemoryPanelProps {
  packageId: string;
  /** Run-scoped view: filter all rows by `runId`, hide scope filter, hide delete buttons. */
  runId?: string;
  /** Optional entry filter used by overview deep links. */
  initialTypes?: Array<"pinned" | "archive">;
}

const EMPTY_MEMORY_TYPES: Array<"pinned" | "archive"> = [];
const MEMORY_TYPES = ["pinned", "archive"] as const;
const MEMORY_SCOPES = ["shared", "mine"] as const;

/** Pinned slots (always-in-prompt, incl. `checkpoint`) and archive memories in one filterable list. */
export function MemoryPanel({
  packageId,
  runId,
  initialTypes = EMPTY_MEMORY_TYPES,
}: MemoryPanelProps) {
  const { t } = useTranslation(["agents", "common"]);
  const isRunView = !!runId;

  // The hook union narrows nicely if we just call both forms conditionally
  // and pick the active one — they share the same shape under the hood.
  const agentPinnedQ = useAgentPinned(isRunView ? undefined : packageId);
  const runPinnedQ = useRunPinned(isRunView ? packageId : undefined, runId);
  const agentMemoriesQ = useAgentMemories(isRunView ? undefined : packageId);
  const runMemoriesQ = useRunMemories(isRunView ? packageId : undefined, runId);

  const pinnedQ = isRunView ? runPinnedQ : agentPinnedQ;
  const memoriesQ = isRunView ? runMemoriesQ : agentMemoriesQ;
  const pinned = pinnedQ.data;
  const memories = memoriesQ.data;

  const deleteMemory = useDeleteMemory(packageId);
  const deletePinned = useDeletePinnedSlot(packageId);
  const { can } = usePermissions();
  const canDelete = !isRunView && can("persistence:delete");
  const [toDelete, setToDelete] = useState<{ kind: "pinned" | "archive"; id: number } | null>(null);
  const deletion = toDelete?.kind === "pinned" ? deletePinned : deleteMemory;

  const isLoading = pinnedQ.isLoading || memoriesQ.isLoading;
  const isError = pinnedQ.isError || memoriesQ.isError;

  const list = useLocalListParams({ type: initialTypes });
  const types = list.values("type", MEMORY_TYPES);
  const scopes = list.values("scope", MEMORY_SCOPES);
  const { copy } = useCopyToClipboard(1_500);

  const allItems = useMemo<MemoryCollectionItem[]>(
    () => [
      ...(pinned ?? []).map((slot) => ({ ...slot, kind: "pinned" as const })),
      ...(memories ?? []).map((memory) => ({
        ...memory,
        kind: "archive" as const,
        key: null,
        updatedAt: memory.createdAt,
      })),
    ],
    [memories, pinned],
  );

  // The entry read in the modal: `?memory=pinned:12`.
  const memoryParam = useUrlModalTarget(
    "memory",
    isLoading ? undefined : allItems,
    (item) => `${item.kind}:${item.id}`,
  );
  const selected = memoryParam.target ?? null;

  const filteredItems = filterMemoryItems(allItems, { query: list.search, scopes, types });

  const filters: FilterSpec[] = [
    {
      id: "type",
      label: t("agents:detail.memoryTypeFilterLabel"),
      values: types,
      options: [
        { value: "pinned", label: t("agents:detail.memoryTabPinned") },
        { value: "archive", label: t("agents:detail.memorySectionArchive") },
      ],
      onChange: list.setValues("type"),
    },
    ...(!isRunView
      ? [
          {
            id: "scope",
            label: t("agents:detail.memoryScopeFilterLabel"),
            values: scopes,
            options: [
              { value: "shared", label: t("agents:detail.memoryScopeShared") },
              { value: "mine", label: t("agents:detail.memoryScopeMine") },
            ],
            onChange: list.setValues("scope"),
          },
        ]
      : []),
  ];
  const columns = useMemoryColumns({
    // Only the row being deleted shows the spinner.
    isDeleting: (item) =>
      deletion.isPending && toDelete?.kind === item.kind && toDelete.id === item.id,
    onCopy: (item) => void copy(memoryText(item.content)),
    onDelete: canDelete ? (item) => setToDelete({ kind: item.kind, id: item.id }) : undefined,
  });

  // Empty in BOTH tiers, once both answered: two failed queries also count zero, and a 500 must not draw "no memory yet".
  if (!isLoading && !isError && allItems.length === 0) {
    return (
      <EmptyState
        message={isRunView ? t("run.memoryEmpty") : t("detail.memoryEmptyAll")}
        hint={isRunView ? undefined : t("detail.memoryEmptyAllHint")}
        icon={BrainCircuit}
        compact
      />
    );
  }

  const selectedTypeLabel =
    selected?.kind === "pinned"
      ? t("agents:detail.memoryTypePinned")
      : t("agents:detail.memoryTypeArchive");

  return (
    <>
      {/* Run results already own the section heading and outer content padding. */}
      <section className={isRunView ? "min-w-0" : "min-w-0 p-6"}>
        <ListToolbar
          search={{
            value: list.search,
            onChange: list.setSearch,
            placeholder: t("agents:detail.memorySearch"),
          }}
          filters={filters}
          onReset={list.reset}
        />
        {!isRunView && (
          <p className="text-muted-foreground mb-2 text-xs">{t("agents:detail.memoryHelp")}</p>
        )}
        <DataTable
          tableId="package-memories"
          tiered
          label={t("agents:detail.tabMemory")}
          columns={columns}
          rows={filteredItems}
          rowKey={(item) => `${item.kind}:${item.id}`}
          rowAction={(item) => memoryParam.open(`${item.kind}:${item.id}`)}
          rowLabel={(item) => item.key ?? memoryText(item.content)}
          isLoading={isLoading}
          failure={pinnedQ.error ?? memoriesQ.error}
          empty={<NoMatchState message={t("agents:list.noMatch")} onReset={list.reset} />}
        />
      </section>
      {selected !== null && (
        <Modal
          onClose={memoryParam.close}
          title={selected.key ?? selectedTypeLabel}
          className="max-w-3xl"
        >
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-sm">{selectedTypeLabel}</span>
              <ActorBadge actor_type={selected.actor_type} actor_id={selected.actor_id} />
              {selected.updatedAt && (
                <span className="text-muted-foreground ml-auto text-xs">
                  {formatDateField(selected.updatedAt, "datetime")}
                </span>
              )}
            </div>
            <pre className="bg-muted/40 max-h-[60vh] overflow-auto rounded-md p-4 text-sm whitespace-pre-wrap">
              {memoryText(selected.content)}
            </pre>
          </div>
        </Modal>
      )}
      <ConfirmModal
        open={toDelete !== null}
        onClose={() => setToDelete(null)}
        onConfirm={() => {
          if (toDelete) deletion.mutate(toDelete.id, { onSuccess: () => setToDelete(null) });
        }}
        title={t("detail.memoryDeleteTitle")}
        description={t("detail.memoryDeleteConfirm")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        isPending={deletion.isPending}
      />
    </>
  );
}
