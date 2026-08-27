// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import {
  BrainCircuit,
  ChevronDown,
  Copy,
  FileText,
  Library,
  MoreHorizontal,
  Pin,
  Trash2,
} from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@appstrate/ui/components/dropdown-menu";
import type { PersistenceActorType } from "@appstrate/shared-types";
import { EmptyState, ErrorState, LoadingState } from "../page-states";
import { ItemList } from "../item-list";
import { MemoryRow } from "./memory-row";
import { PinnedSlotCard } from "./pinned-slot-card";
import { ActorBadge } from "./actor-badge";
import { ListToolbar, type FilterSpec } from "../list-toolbar";
import { Modal } from "../modal";
import { formatDateField } from "../../lib/markdown";
import { useCopyToClipboard } from "../../hooks/use-copy-to-clipboard";
import {
  useAgentMemories,
  useAgentPinned,
  useDeletePinnedSlot,
  useRunMemories,
  useRunPinned,
} from "../../hooks/use-persistence";
import { useDeleteMemory } from "../../hooks/use-mutations";
import { AgentDetailSplit } from "../agent-detail/agent-detail-split";
import { RailButton } from "../settings/rail-link";

export interface MemoryPanelProps {
  packageId: string;
  /** Run-scoped view: filter all rows by `runId`, hide scope filter, hide delete buttons. */
  runId?: string;
}

/**
 * Unified memory view: pinned slots (always-in-prompt blocks
 * including `checkpoint`) on top, archive memories below.
 * Mirrors the Letta ADE pattern of one inspector with two tiers visible
 * side by side.
 */
/**
 * A tier with nothing in it. Quiet on purpose: the panel already draws the
 * ringed empty state when BOTH tiers are empty, and two of those stacked on one
 * screen would read as two failures rather than as one calm answer.
 */
function SectionEmpty({ message }: { message: string }) {
  return <p className="text-muted-foreground/70 px-2 py-2 text-xs italic">{message}</p>;
}

export function MemoryPanel({ packageId, runId }: MemoryPanelProps) {
  const { t } = useTranslation(["agents", "common"]);
  const isRunView = !!runId;

  // The hook union narrows nicely if we just call both forms conditionally
  // and pick the active one — they share the same shape under the hood.
  const agentPinnedQ = useAgentPinned(isRunView ? undefined : packageId, "all");
  const runPinnedQ = useRunPinned(isRunView ? packageId : undefined, runId);
  const agentMemoriesQ = useAgentMemories(isRunView ? undefined : packageId, "all");
  const runMemoriesQ = useRunMemories(isRunView ? packageId : undefined, runId);

  const pinnedQ = isRunView ? runPinnedQ : agentPinnedQ;
  const memoriesQ = isRunView ? runMemoriesQ : agentMemoriesQ;
  const pinned = pinnedQ.data;
  const memories = memoriesQ.data;

  const deleteMemory = useDeleteMemory(packageId);
  const deletePinned = useDeletePinnedSlot(packageId);

  const pinnedCount = pinned?.length ?? 0;
  const memoriesCount = memories?.length ?? 0;
  const isLoading = pinnedQ.isLoading || memoriesQ.isLoading;
  const isError = pinnedQ.isError || memoriesQ.isError;

  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [archiveOpen, setArchiveOpen] = useState(true);

  // Nothing in EITHER tier, and only once both requests have answered. This
  // used to be the panel's single early return, taken on the counts alone: two
  // queries that had failed both counted zero, so a 500 on the endpoint drew
  // "no memory yet" — the collection lie this family exists to end. Failure and
  // loading are now answered per section by `ItemList`, and this one keeps only
  // what it was ever entitled to say.
  if (isRunView && !isLoading && !isError && pinnedCount + memoriesCount === 0) {
    return (
      <EmptyState
        message={isRunView ? t("run.memoryEmpty") : t("detail.memoryEmptyAll")}
        hint={isRunView ? undefined : t("detail.memoryEmptyAllHint")}
        icon={BrainCircuit}
        compact
      />
    );
  }

  if (!isRunView) {
    return (
      <AgentMemoryCollection
        pinned={pinned ?? []}
        memories={memories ?? []}
        pinnedLoading={pinnedQ.isLoading}
        memoriesLoading={memoriesQ.isLoading}
        pinnedError={pinnedQ.isError}
        memoriesError={memoriesQ.isError}
        onDeletePinned={(id) => deletePinned.mutate(id)}
        onDeleteMemory={(id) => deleteMemory.mutate(id)}
        isDeleting={deletePinned.isPending || deleteMemory.isPending}
      />
    );
  }

  return (
    <div className="space-y-5">
      <Section
        open={pinnedOpen}
        onOpenChange={setPinnedOpen}
        icon={<Pin className="h-3.5 w-3.5" />}
        title={t("detail.memorySectionPinned")}
        count={pinnedQ.isSuccess ? pinnedCount : undefined}
        accentClass="text-primary"
      >
        <ItemList
          items={pinned ?? []}
          itemKey={(slot) => String(slot.id)}
          isLoading={pinnedQ.isLoading}
          isError={pinnedQ.isError}
          empty={<SectionEmpty message={t("detail.memorySectionPinnedEmpty")} />}
          renderItem={(slot) => (
            <PinnedSlotCard
              slot={slot}
              onDelete={isRunView ? undefined : (id) => deletePinned.mutate(id)}
              isDeleting={deletePinned.isPending}
            />
          )}
        />
      </Section>

      <Section
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        icon={<Library className="h-3.5 w-3.5" />}
        title={t("detail.memorySectionArchive")}
        count={memoriesQ.isSuccess ? memoriesCount : undefined}
        accentClass="text-muted-foreground"
      >
        <ItemList
          items={memories ?? []}
          itemKey={(mem) => String(mem.id)}
          isLoading={memoriesQ.isLoading}
          isError={memoriesQ.isError}
          empty={<SectionEmpty message={t("detail.memorySectionArchiveEmpty")} />}
          renderItem={(mem) => (
            <MemoryRow
              memory={mem}
              onDelete={isRunView ? undefined : (id) => deleteMemory.mutate(id)}
              isDeleting={deleteMemory.isPending}
            />
          )}
        />
      </Section>
    </div>
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

function memoryText(content: unknown): string {
  return typeof content === "string"
    ? content
    : (JSON.stringify(content, null, 2) ?? String(content));
}

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
  onDeletePinned: (id: number) => void;
  onDeleteMemory: (id: number) => void;
  isDeleting: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  const location = useLocation();
  const navigate = useNavigate();
  const [query, setQuery] = useState("");
  const [scopes, setScopes] = useState<string[]>([]);
  const requestedTier = new URLSearchParams(location.search).get("agentMemory");
  const tier: "pinned" | "archive" = requestedTier === "archive" ? "archive" : "pinned";
  const setTier = (nextTier: "pinned" | "archive") => {
    const search = new URLSearchParams(location.search);
    search.set("agentMemory", nextTier);
    void navigate(
      { pathname: location.pathname, search: `?${search.toString()}`, hash: "#memory" },
      { replace: true },
    );
  };
  const [selected, setSelected] = useState<MemoryCollectionItem | null>(null);
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

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const filteredItems = allItems.filter((item) => {
    const scope = item.actor_type === "shared" ? "shared" : "mine";
    const scopeMatches = scopes.length === 0 || scopes.includes(scope);
    const queryMatches =
      normalizedQuery === "" ||
      item.key?.toLocaleLowerCase().includes(normalizedQuery) ||
      memoryText(item.content).toLocaleLowerCase().includes(normalizedQuery);
    return scopeMatches && queryMatches;
  });
  const pinnedItems = filteredItems.filter((item) => item.kind === "pinned");
  const archiveItems = filteredItems.filter((item) => item.kind === "archive");

  const filters: FilterSpec[] = [
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
  ];

  const activeTitle =
    tier === "pinned"
      ? t("agents:detail.memorySectionPinned")
      : t("agents:detail.memorySectionArchive");
  const activeTable =
    tier === "pinned" ? (
      <MemoryTableSection
        title={t("agents:detail.memorySectionPinned")}
        count={pinnedLoading || pinnedError ? undefined : pinnedItems.length}
        items={pinnedItems}
        isLoading={pinnedLoading}
        isError={pinnedError}
        empty={t("agents:detail.memorySectionPinnedEmpty")}
        onOpen={setSelected}
        onCopy={(item) => void copy(memoryText(item.content))}
        onDelete={(item) => onDeletePinned(item.id)}
        isDeleting={isDeleting}
        hideHeading
      />
    ) : (
      <MemoryTableSection
        title={t("agents:detail.memorySectionArchive")}
        count={memoriesLoading || memoriesError ? undefined : archiveItems.length}
        items={archiveItems}
        isLoading={memoriesLoading}
        isError={memoriesError}
        empty={t("agents:detail.memorySectionArchiveEmpty")}
        onOpen={setSelected}
        onCopy={(item) => void copy(memoryText(item.content))}
        onDelete={(item) => onDeleteMemory(item.id)}
        isDeleting={isDeleting}
        hideHeading
      />
    );

  return (
    <>
      <AgentDetailSplit
        data-agent-memory-collection
        railClassName="p-3"
        rail={
          <nav
            className="flex flex-col gap-0.5 max-md:flex-row max-md:overflow-x-auto"
            aria-label={t("agents:detail.tabMemory")}
          >
            <RailButton
              icon={Pin}
              label={t("agents:detail.memoryTabPinned")}
              count={pinnedLoading || pinnedError ? undefined : pinned.length}
              active={tier === "pinned"}
              onClick={() => setTier("pinned")}
            />
            <RailButton
              icon={Library}
              label={t("agents:detail.memorySectionArchive")}
              count={memoriesLoading || memoriesError ? undefined : memories.length}
              active={tier === "archive"}
              onClick={() => setTier("archive")}
            />
          </nav>
        }
      >
        <section className="min-w-0 p-6">
          <h2 className="text-lg font-semibold">{activeTitle}</h2>
          <div className="border-border mt-2 border-b" />
          <div className="pt-4">
            <ListToolbar
              placement="panel"
              search={{
                value: query,
                onChange: setQuery,
                placeholder: t("agents:detail.memorySearch"),
              }}
              filters={filters}
              panelFiltersAdjacent
              onReset={() => {
                setScopes([]);
              }}
            />
            <p className="text-muted-foreground text-xs">{t("agents:detail.memoryHelp")}</p>
            <div className="pt-5">{activeTable}</div>
          </div>
        </section>
      </AgentDetailSplit>
      <Modal
        open={selected !== null}
        onClose={() => setSelected(null)}
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
  count,
  items,
  isLoading,
  isError,
  empty,
  onOpen,
  onCopy,
  onDelete,
  isDeleting,
  hideHeading = false,
}: {
  title: string;
  count: number | undefined;
  items: MemoryCollectionItem[];
  isLoading: boolean;
  isError: boolean;
  empty: string;
  onOpen: (item: MemoryCollectionItem) => void;
  onCopy: (item: MemoryCollectionItem) => void;
  onDelete: (item: MemoryCollectionItem) => void;
  isDeleting: boolean;
  hideHeading?: boolean;
}) {
  const { t } = useTranslation(["agents", "common"]);
  return (
    <section>
      {!hideHeading && (
        <div className="border-border flex items-center gap-2 border-b pb-2">
          <h2 className="text-lg font-semibold">{title}</h2>
          {count !== undefined && (
            <span className="bg-muted text-muted-foreground inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-medium">
              {count}
            </span>
          )}
        </div>
      )}

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
            className="text-muted-foreground grid grid-cols-[7rem_minmax(0,1fr)_8rem_10rem_2.5rem] gap-3 border-b px-3 py-2 text-[11px] font-semibold tracking-wide uppercase"
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
                onDelete={() => onDelete(item)}
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
  onDelete: () => void;
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
            <DropdownMenuItem
              disabled={isDeleting}
              className="text-destructive focus:text-destructive"
              onSelect={onDelete}
            >
              <Trash2 />
              {t("common:btn.delete")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </span>
    </div>
  );
}

interface SectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: React.ReactNode;
  title: string;
  /** Undefined until the request has answered — see the note on the pill. */
  count?: number;
  accentClass: string;
  children: React.ReactNode;
}

/**
 * The heading a tier hangs under: a disclosure, a name, and its count.
 *
 * It no longer decides what to draw when the tier is empty. That was the
 * section's own italic sentence, which meant emptiness was answered in one
 * place, failure nowhere, and loading nowhere — the body owns all three now,
 * in the family's order.
 */
function Section({ open, onOpenChange, icon, title, count, accentClass, children }: SectionProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <CollapsibleTrigger className="hover:bg-muted/30 group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left">
        <ChevronDown
          className={`text-muted-foreground h-3.5 w-3.5 shrink-0 transition-transform ${
            open ? "" : "-rotate-90"
          }`}
        />
        <span className={`flex shrink-0 items-center ${accentClass}`}>{icon}</span>
        <span className="text-foreground text-sm font-semibold tracking-tight">{title}</span>
        {/* Only for an answer we have. `data?.length ?? 0` on a failed request
            is a pill reading "0" over a body reading "this failed" — the same
            lie the run list's footer had to be cured of, one level down. */}
        {count !== undefined && (
          <span className="bg-muted text-muted-foreground inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] leading-none font-medium">
            {count}
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">{children}</CollapsibleContent>
    </Collapsible>
  );
}
