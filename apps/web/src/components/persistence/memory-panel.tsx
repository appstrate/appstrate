// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, Copy, FileText, MoreHorizontal, Pin, Trash2 } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { EmptyState, ErrorState, LoadingState } from "../page-states";
import { ActorBadge } from "./actor-badge";
import { ListToolbar, type FilterSpec } from "../list-toolbar";
import { Modal } from "../modal";
import { ConfirmModal } from "../confirm-modal";
import { formatDateField } from "../../lib/format-date";
import { filterMemoryItems, memoryText } from "../../lib/memory-items";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import { useModalParam } from "../../hooks/use-modal-param";
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
 * A tier with nothing in it. Quiet on purpose: the panel already draws the
 * ringed empty state when BOTH tiers are empty, and two of those stacked on one
 * screen would read as two failures rather than as one calm answer.
 */
function SectionEmpty({ message }: { message: string }) {
  return <p className="text-muted-foreground/70 px-2 py-2 text-xs italic">{message}</p>;
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
  // answered per section by `ItemList`; this return says only that both tiers
  // are empty.
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
        pinnedError={pinnedQ.isError}
        memoriesError={memoriesQ.isError}
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

interface MemoryCollectionItem {
  id: number;
  kind: "pinned" | "archive";
  key: string | null;
  content: unknown;
  actor_type: PersistenceActorType;
  actor_id: string | null;
  runId: string | null;
  updatedAt: string | null;
}

const EMPTY_MEMORY_TYPES: Array<"pinned" | "archive"> = [];
const CHECKPOINT_KEY = "checkpoint";

function AgentMemoryCollection({
  pinned,
  memories,
  pinnedLoading,
  memoriesLoading,
  pinnedError,
  memoriesError,
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
  pinnedError: boolean;
  memoriesError: boolean;
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
  const memoryParam = useModalParam("memory");
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

  // The entry read in the modal: `?memory=pinned:12`. One the list no longer holds shows nothing.
  const selected = allItems.find((item) => `${item.kind}:${item.id}` === memoryParam.value) ?? null;

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
  const activeTable = (
    <MemoryTableSection
      title={t("agents:detail.tabMemory")}
      items={filteredItems}
      isLoading={pinnedLoading || memoriesLoading}
      isError={pinnedError || memoriesError}
      empty={t("agents:detail.memoryEmptyAll")}
      onOpen={(item) => memoryParam.open(`${item.kind}:${item.id}`)}
      onCopy={(item) => void copy(memoryText(item.content))}
      onDelete={
        canDelete
          ? (item) => {
              if (item.kind === "pinned") onDeletePinned?.(item.id);
              else onDeleteMemory?.(item.id);
            }
          : undefined
      }
      isDeleting={isDeleting}
    />
  );

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
        onReset={() => {
          setTypes([]);
          setScopes([]);
        }}
      />
      {!embedded && (
        <p className="text-muted-foreground mb-2 text-xs">{t("agents:detail.memoryHelp")}</p>
      )}
      <div>{activeTable}</div>
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

function MemoryTableSection({
  title,
  items,
  isLoading,
  isError,
  empty,
  onOpen,
  onCopy,
  onDelete,
  isDeleting,
}: {
  /** Accessible name of the table. */
  title: string;
  items: MemoryCollectionItem[];
  isLoading: boolean;
  isError: boolean;
  empty: string;
  onOpen: (item: MemoryCollectionItem) => void;
  onCopy: (item: MemoryCollectionItem) => void;
  onDelete?: (item: MemoryCollectionItem) => void;
  isDeleting: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  return (
    <section>
      {isLoading ? (
        <LoadingState />
      ) : isError ? (
        <ErrorState compact />
      ) : items.length === 0 ? (
        <SectionEmpty message={empty} />
      ) : (
        <div role="table" aria-label={title}>
          <div
            role="row"
            className="text-muted-foreground grid grid-cols-[7rem_minmax(0,1fr)_8rem_10rem_2.5rem] gap-3 border-y px-3 py-2 text-[11px] font-semibold tracking-wide uppercase"
          >
            <span role="columnheader">{t("agents:detail.memoryColumnType")}</span>
            <span role="columnheader">{t("agents:detail.memoryColumnContent")}</span>
            <span role="columnheader">{t("agents:detail.memoryColumnScope")}</span>
            <span role="columnheader">{t("agents:detail.memoryColumnUpdated")}</span>
            <span role="columnheader" className="text-right">
              {t("agents:detail.memoryColumnActions")}
            </span>
          </div>
          <div role="rowgroup" className="divide-y">
            {items.map((item) => (
              <MemoryCollectionRow
                key={`${item.kind}:${item.id}`}
                item={item}
                onOpen={() => onOpen(item)}
                onCopy={() => onCopy(item)}
                onDelete={onDelete ? () => onDelete(item) : undefined}
                isDeleting={isDeleting}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function MemoryCollectionRow({
  item,
  onOpen,
  onCopy,
  onDelete,
  isDeleting,
}: {
  item: MemoryCollectionItem;
  onOpen: () => void;
  onCopy: () => void;
  onDelete?: () => void;
  isDeleting: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const content = memoryText(item.content);
  return (
    <div
      role="row"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        // Only the row's own focus: a key on its "…" menu belongs to the menu.
        if (event.target !== event.currentTarget) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      className="hover:bg-muted/35 focus-visible:ring-ring grid cursor-pointer grid-cols-[7rem_minmax(0,1fr)_8rem_10rem_2.5rem] items-center gap-3 px-3 py-3 outline-none focus-visible:ring-2"
    >
      <span role="cell" className="flex items-center gap-2 text-sm">
        {item.kind === "pinned" ? (
          <Pin className="text-primary size-3.5" aria-hidden />
        ) : (
          <FileText className="text-muted-foreground size-3.5" aria-hidden />
        )}
        {item.kind === "pinned"
          ? t("agents:detail.memoryTypePinned")
          : t("agents:detail.memoryTypeArchive")}
      </span>
      <span role="cell" className="min-w-0">
        {item.key && <code className="mr-2 text-xs font-semibold">{item.key}</code>}
        {item.key === CHECKPOINT_KEY && (
          <span className="text-muted-foreground mr-2 text-[10px] tracking-wide uppercase">
            {t("agents:detail.pinnedCheckpointHint")}
          </span>
        )}
        <span className="text-muted-foreground block truncate text-sm" title={content}>
          {content}
        </span>
      </span>
      <span role="cell">
        <ActorBadge actor_type={item.actor_type} actor_id={item.actor_id} />
      </span>
      <span role="cell" className="text-muted-foreground text-xs whitespace-nowrap">
        {item.updatedAt ? formatDateField(item.updatedAt) : "—"}
      </span>
      <span role="cell" onClick={(event) => event.stopPropagation()}>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("agents:detail.memoryRowActions")}
              className="size-8"
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={onCopy}>
              <Copy />
              {t("common:btn.copy")}
            </DropdownMenuItem>
            {onDelete && (
              <DropdownMenuItem
                disabled={isDeleting}
                className="text-destructive focus:text-destructive"
                onSelect={onDelete}
              >
                <Trash2 />
                {t("common:btn.delete")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
}
