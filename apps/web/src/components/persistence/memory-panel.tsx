// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
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
  useDeletePersistenceRow,
  useRunMemories,
  useRunPinned,
  type PersistenceRowRef,
} from "../../hooks/use-persistence";
import { useRowSpaceGrants } from "../../hooks/use-permissions";
import { useSpacesFor } from "../../hooks/use-space-action";
import { SpaceNameOf } from "../space-name";
import { authStore } from "../../stores/auth-store";

interface MemoryPanelProps {
  packageId: string;
  /** Run-scoped view: filter all rows by `runId`, hide scope filter, hide delete buttons. */
  runId?: string;
  /** Optional entry filter used by overview deep links. */
  initialTypes?: Array<"pinned" | "archive">;
  /** The agent's memory in every space the reader reaches, each row naming its space (agent view only). */
  spanning?: boolean;
}

const EMPTY_MEMORY_TYPES: Array<"pinned" | "archive"> = [];
const MEMORY_TYPES = ["pinned", "archive"] as const;
const MEMORY_SCOPES = ["shared", "mine", "others"] as const;

/** Pinned slots (always-in-prompt, incl. `checkpoint`) and archive memories in one filterable list. */
export function MemoryPanel({
  packageId,
  runId,
  initialTypes = EMPTY_MEMORY_TYPES,
  spanning = false,
}: MemoryPanelProps) {
  const { t } = useTranslation(["agents", "common"]);
  const isRunView = !!runId;

  // The hook union narrows nicely if we just call both forms conditionally
  // and pick the active one — they share the same shape under the hood.
  const agentPinnedQ = useAgentPinned(isRunView ? undefined : packageId, { spanning });
  const runPinnedQ = useRunPinned(isRunView ? packageId : undefined, runId);
  const agentMemoriesQ = useAgentMemories(isRunView ? undefined : packageId, { spanning });
  const runMemoriesQ = useRunMemories(isRunView ? packageId : undefined, runId);

  const pinnedQ = isRunView ? runPinnedQ : agentPinnedQ;
  const memoriesQ = isRunView ? runMemoriesQ : agentMemoriesQ;
  const pinned = pinnedQ.data;
  const memories = memoriesQ.data;

  const deletion = useDeletePersistenceRow(packageId);
  // `persistence:delete` is also what lets the API return other actors' rows: in the working
  // space, or in some space when the list spans them.
  const readsEveryActor = useSpacesFor({ permission: "persistence:delete" }).offered;
  // A row is deleted in its own space, where that space grants it.
  const grantsInRowSpace = useRowSpaceGrants();
  const userId = useStore(authStore, (s) => s.user?.id);
  const [toDelete, setToDelete] = useState<PersistenceRowRef | null>(null);

  const isLoading = pinnedQ.isLoading || memoriesQ.isLoading;

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
    pinned && memories ? allItems : undefined,
    (item) => `${item.kind}:${item.id}`,
  );
  const selected = memoryParam.target ?? null;

  const filteredItems = filterMemoryItems(allItems, { query: list.search, scopes, types }, userId);

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
              ...(readsEveryActor
                ? [{ value: "others", label: t("agents:detail.memoryScopeOthers") }]
                : []),
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
    onDelete: (item) =>
      !isRunView && grantsInRowSpace(item.spaceId, "persistence:delete")
        ? () => setToDelete({ kind: item.kind, id: item.id, spaceId: item.spaceId })
        : undefined,
    spanning,
  });

  const selectedTypeLabel =
    selected?.kind === "pinned"
      ? t("agents:detail.memoryTypePinned")
      : t("agents:detail.memoryTypeArchive");

  return (
    <>
      {/* Laid on the page like the runs tab: its toolbar, then the table in its own card. */}
      <section className="min-w-0">
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
          label={t("agents:detail.tabMemory")}
          columns={columns}
          rows={filteredItems}
          rowKey={(item) => `${item.kind}:${item.id}`}
          rowAction={(item) => memoryParam.open(`${item.kind}:${item.id}`)}
          rowLabel={(item) => item.key ?? memoryText(item.content)}
          isLoading={isLoading}
          failure={pinnedQ.error ?? memoriesQ.error}
          // Like the runs tab: an empty list keeps its toolbar and says so inside its card; "no
          // memory yet" only once both tiers answered (two failed reads also count zero).
          empty={
            allItems.length === 0 ? (
              <EmptyState
                message={isRunView ? t("run.memoryEmpty") : t("detail.memoryEmptyAll")}
                hint={isRunView ? undefined : t("detail.memoryEmptyAllHint")}
                icon={BrainCircuit}
                compact
              />
            ) : (
              <NoMatchState message={t("agents:list.noMatch")} onReset={list.reset} />
            )
          }
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
              {spanning && (
                <SpaceNameOf spaceId={selected.spaceId} className="text-muted-foreground" />
              )}
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
          if (toDelete) deletion.mutate(toDelete, { onSuccess: () => setToDelete(null) });
        }}
        title={t("detail.memoryDeleteTitle")}
        description={t("detail.memoryDeleteConfirm")}
        confirmLabel={t("btn.delete", { ns: "common" })}
        isPending={deletion.isPending}
      />
    </>
  );
}
