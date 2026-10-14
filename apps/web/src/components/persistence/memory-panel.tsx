// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit } from "lucide-react";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { EmptyState, NoMatchState } from "../page-states";
import { ActorBadge } from "./actor-badge";
import { useMemoryColumns, type MemoryCollectionItem } from "./memory-columns";
import { DataTable } from "../data-table";
import { ListToolbar, type FilterSpec } from "../list-toolbar";
import { Modal } from "../modal";
import { ConfirmModal } from "../confirm-modal";
import { formatDateField } from "../../lib/format-date";
import { filterMemoryItems, memoryText } from "../../lib/memory-items";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { useModalTarget } from "../../hooks/use-modal-param";
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

/**
 * Unified memory view: pinned slots (always-in-prompt blocks
 * including `checkpoint`) and archive memories in one filterable list.
 * Mirrors the Letta ADE pattern of one inspector over both tiers.
 */
export function MemoryPanel({ packageId, runId, initialTypes }: MemoryPanelProps) {
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
  const [toDelete, setToDelete] = useState<{ kind: "pinned" | "memory"; id: number } | null>(null);
  const deletion = toDelete?.kind === "pinned" ? deletePinned : deleteMemory;

  const pinnedCount = pinned?.length ?? 0;
  const memoriesCount = memories?.length ?? 0;
  const isLoading = pinnedQ.isLoading || memoriesQ.isLoading;
  const isError = pinnedQ.isError || memoriesQ.isError;

  // Nothing in EITHER tier, and only once both requests have answered. The
  // counts alone are not enough: two queries that failed both count zero, and a
  // 500 on the endpoint must not draw "no memory yet". Failure and loading are
  // answered by the table; this return says only that both tiers are empty.
  if (!isLoading && !isError && pinnedCount + memoriesCount === 0) {
    return (
      <EmptyState
        message={isRunView ? t("run.memoryEmpty") : t("detail.memoryEmptyAll")}
        hint={isRunView ? undefined : t("detail.memoryEmptyAllHint")}
        icon={BrainCircuit}
        compact
      />
    );
  }

  return (
    <>
      <AgentMemoryCollection
        pinned={pinned ?? []}
        memories={memories ?? []}
        pinnedLoading={pinnedQ.isLoading}
        memoriesLoading={memoriesQ.isLoading}
        failure={pinnedQ.error ?? memoriesQ.error}
        onDeletePinned={canDelete ? (id) => setToDelete({ kind: "pinned", id }) : undefined}
        onDeleteMemory={canDelete ? (id) => setToDelete({ kind: "memory", id }) : undefined}
        isDeleting={deletePinned.isPending || deleteMemory.isPending}
        embedded={isRunView}
        initialTypes={initialTypes}
      />
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

const EMPTY_MEMORY_TYPES: Array<"pinned" | "archive"> = [];

function AgentMemoryCollection({
  pinned,
  memories,
  pinnedLoading,
  memoriesLoading,
  failure,
  onDeletePinned,
  onDeleteMemory,
  isDeleting,
  embedded,
  initialTypes = EMPTY_MEMORY_TYPES,
}: {
  pinned: Array<{
    id: number;
    key: string;
    content: unknown;
    actor_type: PersistenceActorType;
    actor_id: string | null;
    runId: string | null;
    updatedAt: string | null;
  }>;
  memories: Array<{
    id: number;
    content: unknown;
    actor_type: PersistenceActorType;
    actor_id: string | null;
    runId: string | null;
    createdAt: string | null;
  }>;
  pinnedLoading: boolean;
  memoriesLoading: boolean;
  failure: unknown;
  onDeletePinned?: (id: number) => void;
  onDeleteMemory?: (id: number) => void;
  isDeleting: boolean;
  /** Run results already own the section heading and outer content padding. */
  embedded: boolean;
  initialTypes?: Array<"pinned" | "archive">;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const [query, setQuery] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const [types, setTypes] = useState<string[]>(initialTypes);
  const { copy } = useCopyToClipboard(1_500);

  const allItems = useMemo<MemoryCollectionItem[]>(
    () => [
      ...pinned.map((item) => ({
        id: item.id,
        kind: "pinned" as const,
        key: item.key,
        content: item.content,
        actor_type: item.actor_type,
        actor_id: item.actor_id,
        runId: item.runId,
        updatedAt: item.updatedAt,
      })),
      ...memories.map((item) => ({
        id: item.id,
        kind: "archive" as const,
        key: null,
        content: item.content,
        actor_type: item.actor_type,
        actor_id: item.actor_id,
        runId: item.runId,
        updatedAt: item.createdAt,
      })),
    ],
    [memories, pinned],
  );

  // The entry read in the modal: `?memory=pinned:12`.
  const memoryParam = useModalTarget(
    "memory",
    pinnedLoading || memoriesLoading ? undefined : allItems,
    (item) => `${item.kind}:${item.id}`,
  );
  const selected = memoryParam.target ?? null;

  const filteredItems = filterMemoryItems(allItems, { query, scopes, types });

  const filters: FilterSpec[] = [
    {
      id: "type",
      label: t("agents:detail.memoryTypeFilterLabel"),
      values: types,
      options: [
        { value: "pinned", label: t("agents:detail.memoryTabPinned") },
        { value: "archive", label: t("agents:detail.memorySectionArchive") },
      ],
      onChange: setTypes,
    },
    ...(!embedded
      ? [
          {
            id: "scope",
            label: t("agents:detail.memoryScopeFilterLabel"),
            values: scopes,
            options: [
              { value: "shared", label: t("agents:detail.memoryScopeShared") },
              { value: "mine", label: t("agents:detail.memoryScopeMine") },
            ],
            onChange: setScopes,
          },
        ]
      : []),
  ];
  const canDelete = Boolean(onDeletePinned || onDeleteMemory);
  const columns = useMemoryColumns({
    isDeleting,
    onCopy: (item) => void copy(memoryText(item.content)),
    onDelete: canDelete
      ? (item) => {
          if (item.kind === "pinned") onDeletePinned?.(item.id);
          else onDeleteMemory?.(item.id);
        }
      : undefined,
  });
  const reset = () => {
    setQuery("");
    setTypes([]);
    setScopes([]);
  };

  const collection = (
    <section className={embedded ? "min-w-0" : "min-w-0 p-6"}>
      <ListToolbar
        placement="panel"
        search={{
          value: query,
          onChange: setQuery,
          placeholder: t("agents:detail.memorySearch"),
        }}
        filters={filters}
        onReset={reset}
      />
      {!embedded && (
        <p className="text-muted-foreground mb-2 text-xs">{t("agents:detail.memoryHelp")}</p>
      )}
      <DataTable
        tableId="memory"
        label={t("agents:detail.tabMemory")}
        columns={columns}
        rows={filteredItems}
        rowKey={(item) => `${item.kind}:${item.id}`}
        rowAction={(item) => memoryParam.open(`${item.kind}:${item.id}`)}
        rowLabel={(item) => item.key ?? memoryText(item.content)}
        isLoading={pinnedLoading || memoriesLoading}
        failure={failure}
        empty={<NoMatchState message={t("agents:list.noMatch")} onReset={reset} />}
      />
    </section>
  );

  return (
    <>
      {collection}
      <Modal
        open={selected !== null}
        onClose={memoryParam.close}
        title={
          selected?.key ??
          (selected?.kind === "pinned"
            ? t("agents:detail.memoryTypePinned")
            : t("agents:detail.memoryTypeArchive"))
        }
        className="max-w-3xl"
      >
        {selected && (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-muted-foreground text-sm">
                {selected.kind === "pinned"
                  ? t("agents:detail.memoryTypePinned")
                  : t("agents:detail.memoryTypeArchive")}
              </span>
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
        )}
      </Modal>
    </>
  );
}
