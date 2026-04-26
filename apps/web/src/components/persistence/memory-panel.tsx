// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, ChevronDown, Pin, Library } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { EmptyState } from "../page-states";
import { ScopeFilter, type PersistenceScopeFilter } from "./scope-filter";
import { MemoryRow } from "./memory-row";
import { PinnedSlotCard } from "./pinned-slot-card";
import {
  useAgentMemories,
  useAgentPinned,
  useDeletePinnedSlot,
  useRunMemories,
  useRunPinned,
} from "../../hooks/use-persistence";
import { useDeleteMemory } from "../../hooks/use-mutations";

export interface MemoryPanelProps {
  packageId: string;
  /** Run-scoped view: filter all rows by `runId`, hide scope filter, hide delete buttons. */
  runId?: string;
}

/**
 * Unified memory view (ADR-013): pinned slots (always-in-prompt blocks
 * including `checkpoint`) on top, archive memories below.
 * Mirrors the Letta ADE pattern of one inspector with two tiers visible
 * side by side.
 */
export function MemoryPanel({ packageId, runId }: MemoryPanelProps) {
  const { t } = useTranslation(["agents", "common"]);
  const [scopeFilter, setScopeFilter] = useState<PersistenceScopeFilter>("all");
  const isRunView = !!runId;

  // The hook union narrows nicely if we just call both forms conditionally
  // and pick the active one — they share the same shape under the hood.
  const agentPinnedQ = useAgentPinned(isRunView ? undefined : packageId, scopeFilter);
  const runPinnedQ = useRunPinned(isRunView ? packageId : undefined, runId);
  const agentMemoriesQ = useAgentMemories(isRunView ? undefined : packageId, scopeFilter);
  const runMemoriesQ = useRunMemories(isRunView ? packageId : undefined, runId);

  const pinned = isRunView ? runPinnedQ.data : agentPinnedQ.data;
  const memories = isRunView ? runMemoriesQ.data : agentMemoriesQ.data;

  const deleteMemory = useDeleteMemory(packageId);
  const deletePinned = useDeletePinnedSlot(packageId);

  const pinnedCount = pinned?.length ?? 0;
  const memoriesCount = memories?.length ?? 0;
  const hasAnything = pinnedCount + memoriesCount > 0;

  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [archiveOpen, setArchiveOpen] = useState(true);

  if (!hasAnything) {
    return (
      <EmptyState
        message={isRunView ? t("exec.memoryEmpty") : t("detail.memoryEmptyAll")}
        hint={isRunView ? undefined : t("detail.memoryEmptyAllHint")}
        icon={BrainCircuit}
        compact
      />
    );
  }

  return (
    <div className="space-y-5">
      {!isRunView && (
        <div className="flex items-center justify-between">
          <ScopeFilter value={scopeFilter} onChange={setScopeFilter} />
          <p className="text-muted-foreground text-xs">{t("detail.memoryHelp")}</p>
        </div>
      )}

      <Section
        open={pinnedOpen}
        onOpenChange={setPinnedOpen}
        icon={<Pin className="h-3.5 w-3.5" />}
        title={t("detail.memorySectionPinned")}
        count={pinnedCount}
        accentClass="text-primary"
        emptyMessage={t("detail.memorySectionPinnedEmpty")}
        isEmpty={pinnedCount === 0}
      >
        <div className="space-y-2">
          {pinned!.map((slot) => (
            <PinnedSlotCard
              key={slot.id}
              slot={slot}
              onDelete={isRunView ? undefined : (id) => deletePinned.mutate(id)}
              isDeleting={deletePinned.isPending}
            />
          ))}
        </div>
      </Section>

      <Section
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        icon={<Library className="h-3.5 w-3.5" />}
        title={t("detail.memorySectionArchive")}
        count={memoriesCount}
        accentClass="text-muted-foreground"
        emptyMessage={t("detail.memorySectionArchiveEmpty")}
        isEmpty={memoriesCount === 0}
      >
        <div className="space-y-1.5">
          {memories!.map((mem) => (
            <MemoryRow
              key={mem.id}
              memory={mem}
              onDelete={isRunView ? undefined : (id) => deleteMemory.mutate(id)}
              isDeleting={deleteMemory.isPending}
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

interface SectionProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  icon: React.ReactNode;
  title: string;
  count: number;
  accentClass: string;
  emptyMessage: string;
  isEmpty: boolean;
  children: React.ReactNode;
}

function Section({
  open,
  onOpenChange,
  icon,
  title,
  count,
  accentClass,
  emptyMessage,
  isEmpty,
  children,
}: SectionProps) {
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
        <span className="bg-muted text-muted-foreground inline-flex h-5 min-w-[20px] items-center justify-center rounded-full px-1.5 text-[11px] leading-none font-medium">
          {count}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="pt-2">
        {isEmpty ? (
          <p className="text-muted-foreground/70 px-2 py-2 text-xs italic">{emptyMessage}</p>
        ) : (
          children
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
