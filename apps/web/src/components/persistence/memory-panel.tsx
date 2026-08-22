// SPDX-License-Identifier: Apache-2.0

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { BrainCircuit, ChevronDown, Pin, Library } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@appstrate/ui/components/collapsible";
import { EmptyState } from "../page-states";
import { ItemList } from "../item-list";
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
  const [scopeFilter, setScopeFilter] = useState<PersistenceScopeFilter>("all");
  const isRunView = !!runId;

  // The hook union narrows nicely if we just call both forms conditionally
  // and pick the active one — they share the same shape under the hood.
  const agentPinnedQ = useAgentPinned(isRunView ? undefined : packageId, scopeFilter);
  const runPinnedQ = useRunPinned(isRunView ? packageId : undefined, runId);
  const agentMemoriesQ = useAgentMemories(isRunView ? undefined : packageId, scopeFilter);
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
