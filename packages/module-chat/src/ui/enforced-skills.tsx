// SPDX-License-Identifier: Apache-2.0

/**
 * The skills loaded in the conversation, as chips in the composer's tool row: the ones the origin
 * space imposes (locked, read-only: also for a member without `skills:read`) and the ones the user
 * pinned (removable). One line: the first chips, then a « +N » chip listing the rest.
 */

import type { ReactNode } from "react";
import { LockIcon, PlusIcon, XIcon } from "lucide-react";
import { parseScopedName } from "@appstrate/core/naming";
import { badgeVariants } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { cn } from "@appstrate/ui/cn";
import { injectsSkills, type ChatSkillSelection } from "../skills.ts";
import { ownPins, splitSkillChips, togglePinned, type SkillChipModel } from "./chat-skills.ts";
import { useOriginSpaceNode, useSpaceLabel, useConversationScope } from "./conversation-scope.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { sentenceWithNode } from "./sentence-with-name.tsx";
import { useEnforcedSkills } from "./use-enforced-skills.ts";
import { useSkillCatalogue } from "./use-skill-catalogue.ts";

/**
 * What the conversation loads, as chips. Pins count only in a mode that injects them (`auto`
 * keeps them but uses none); an enforced skill is never listed twice.
 */
function useLoadedSkills(transport: ChatTransport | undefined, selection: ChatSkillSelection) {
  const enforcedQuery = useEnforcedSkills(transport);
  const { catalogue } = useSkillCatalogue(transport);
  const enforced = enforcedQuery.data ?? [];
  const enforcedIds = new Set(enforced.map((skill) => skill.packageId));
  const names = new Map((catalogue.data ?? []).map((s) => [s.packageId, s.display_name]));
  const chips: SkillChipModel[] = [
    ...enforced.map((s) => ({
      packageId: s.packageId,
      name: s.display_name ?? s.packageId,
      enforced: true,
    })),
    ...(injectsSkills(selection.skillMode) ? ownPins(selection.pinnedSkills, enforcedIds) : []).map(
      (id) => ({
        packageId: id,
        name: names.get(id) ?? parseScopedName(id)?.name ?? id,
        enforced: false,
      }),
    ),
  ];
  // `isLoading`: the read is off without a space, and would wait forever.
  return { chips, loading: enforcedQuery.isLoading };
}

const CHIP_CLASS = cn(
  badgeVariants({ variant: "secondary" }),
  "text-muted-foreground h-7 min-w-0 shrink gap-1.5 py-0 font-normal",
);

function EnforcedChip({ chip, onOpen }: { chip: SkillChipModel; onOpen?: () => void }) {
  const { t } = useChatHost();
  const spaceNode = useOriginSpaceNode();
  // The plain name: the node above carries a tile the accessible name must not.
  const spaceLabel =
    useSpaceLabel(useConversationScope().originSpaceId) ?? t("composer.limit.thisSpace");
  const label = t("skills.chipEnforcedLabel", { skill: chip.name, space: spaceLabel });
  const body = (
    <>
      <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-32 truncate">{chip.name}</span>
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onOpen ? (
          <button
            type="button"
            data-testid="skill-chip-enforced"
            aria-label={label}
            onClick={onOpen}
            className={cn(CHIP_CLASS, "px-2.5")}
          >
            {body}
          </button>
        ) : (
          <span
            role="note"
            tabIndex={0}
            data-testid="skill-chip-enforced"
            aria-label={label}
            className={cn(CHIP_CLASS, "px-2.5")}
          >
            {body}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        {sentenceWithNode(t, "skills.enforcedBy", spaceNode)}
      </TooltipContent>
    </Tooltip>
  );
}

function PinnedChip({
  chip,
  onOpen,
  onRemove,
}: {
  chip: SkillChipModel;
  onOpen: () => void;
  onRemove: () => void;
}) {
  const { t } = useChatHost();
  return (
    <span data-testid="skill-chip-pinned" className={cn(CHIP_CLASS, "pr-1 pl-2.5")}>
      <button
        type="button"
        aria-label={t("skills.chipOpen", { skill: chip.name })}
        onClick={onOpen}
        className="max-w-32 min-w-0 truncate"
      >
        {chip.name}
      </button>
      <button
        type="button"
        data-testid="skill-chip-remove"
        aria-label={t("skills.chipRemove", { skill: chip.name })}
        onClick={onRemove}
        className="hover:bg-foreground/10 flex size-5 shrink-0 items-center justify-center rounded-full"
      >
        <XIcon className="size-3" aria-hidden="true" />
      </button>
    </span>
  );
}

function OverflowChip({ chips }: { chips: readonly SkillChipModel[] }) {
  const { t } = useChatHost();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="note"
          tabIndex={0}
          data-testid="skill-chip-overflow"
          aria-label={t("skills.chipsMoreLabel", {
            n: chips.length,
            names: chips.map((chip) => chip.name).join(", "),
          })}
          className={cn(CHIP_CLASS, "shrink-0 px-2.5")}
        >
          {t("skills.chipsMore", { n: chips.length })}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        <ul>
          {chips.map((chip) => (
            <li key={chip.packageId}>{chip.name}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

interface SkillChipsProps {
  transport: ChatTransport | undefined;
  selection: ChatSkillSelection;
  onSelectionChange: (selection: ChatSkillSelection) => void;
  /** Absent for a member who cannot pick: the chips are then read-only and enforced-only. */
  onOpenPicker?: () => void;
  /** Drawn when no skill is loaded: today's entry to the picker (its summary chip). */
  fallback?: ReactNode;
}

/** The skill chips of the composer's tool row, or `fallback` while no skill is loaded. */
export function SkillChips({
  transport,
  selection,
  onSelectionChange,
  onOpenPicker,
  fallback = null,
}: SkillChipsProps) {
  const { t } = useChatHost();
  const { chips: all, loading } = useLoadedSkills(transport, selection);
  const enforcedIds = new Set(all.filter((chip) => chip.enforced).map((chip) => chip.packageId));
  // Pins are the user's to edit: without the picker, only what the space imposes shows.
  const chips = onOpenPicker ? all : all.filter((chip) => chip.enforced);
  // Same footprint as a real chip: no layout shift when the read answers.
  if (loading) return <Skeleton className="h-7 w-28 shrink-0 rounded-full" aria-hidden />;
  if (chips.length === 0) return <>{fallback}</>;

  const { visible, overflow } = splitSkillChips(chips);
  return (
    <div
      role="group"
      aria-label={t("skills.chipsLabel")}
      data-testid="skill-chips"
      className="flex min-w-0 flex-nowrap items-center gap-1.5"
    >
      {visible.map((chip) =>
        chip.enforced ? (
          <EnforcedChip key={chip.packageId} chip={chip} onOpen={onOpenPicker} />
        ) : (
          <PinnedChip
            key={chip.packageId}
            chip={chip}
            onOpen={onOpenPicker!}
            onRemove={() =>
              onSelectionChange({
                ...selection,
                pinnedSkills: togglePinned(
                  ownPins(selection.pinnedSkills, enforcedIds),
                  chip.packageId,
                ),
              })
            }
          />
        ),
      )}
      {overflow.length > 0 && <OverflowChip chips={overflow} />}
      {onOpenPicker && (
        <button
          type="button"
          data-testid="skill-chips-add"
          aria-label={t("skills.add")}
          onClick={onOpenPicker}
          className="text-muted-foreground hover:bg-foreground/10 flex size-7 shrink-0 items-center justify-center rounded-full"
        >
          <PlusIcon className="size-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
