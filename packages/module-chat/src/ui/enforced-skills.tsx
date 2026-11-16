// SPDX-License-Identifier: Apache-2.0

/**
 * The skills loaded in the conversation, as pills in the composer's tool row: ONE locked pill for
 * the ones the origin space imposes (also readable by a member without `skills:read`) and ONE for
 * the ones the user added. Each shows its count, or the name when there is a single skill; the
 * tooltip lists the names. Removal happens in the picker, which both pills open.
 */

import type { ReactNode } from "react";
import { BookOpenIcon, LockIcon, PlusIcon } from "lucide-react";
import { parseScopedName } from "@appstrate/core/naming";
import { badgeVariants } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { cn } from "@appstrate/ui/cn";
import { injectsSkills, type ChatSkillSelection } from "../skills.ts";
import { ownPins } from "./chat-skills.ts";
import { useOriginSpaceNode, useSpaceLabel, useConversationScope } from "./conversation-scope.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { sentenceWithNode } from "./sentence-with-name.tsx";
import { useEnforcedSkills } from "./use-enforced-skills.ts";
import { useSkillCatalogue } from "./use-skill-catalogue.ts";

interface LoadedSkill {
  packageId: string;
  name: string;
}

/**
 * What the conversation loads: the origin space's imposed skills and the user's own pins. Pins
 * count only in a mode that injects them (`auto` keeps them but uses none); an enforced skill is
 * never listed twice.
 */
function useLoadedSkills(transport: ChatTransport | undefined, selection: ChatSkillSelection) {
  const enforcedQuery = useEnforcedSkills(transport);
  const { catalogue } = useSkillCatalogue(transport);
  const enforcedSkills = enforcedQuery.data ?? [];
  const enforcedIds = new Set(enforcedSkills.map((skill) => skill.packageId));
  const names = new Map((catalogue.data ?? []).map((s) => [s.packageId, s.display_name]));
  const enforced: LoadedSkill[] = enforcedSkills.map((s) => ({
    packageId: s.packageId,
    name: s.display_name ?? s.packageId,
  }));
  const pinned: LoadedSkill[] = (
    injectsSkills(selection.skillMode) ? ownPins(selection.pinnedSkills, enforcedIds) : []
  ).map((id) => ({
    packageId: id,
    name: names.get(id) ?? parseScopedName(id)?.name ?? id,
  }));
  // `isLoading`: the read is off without a space, and would wait forever.
  return { enforced, pinned, loading: enforcedQuery.isLoading };
}

const PILL_CLASS = cn(
  badgeVariants({ variant: "secondary" }),
  "text-muted-foreground h-7 min-w-0 shrink gap-1.5 px-2.5 py-0 font-normal",
);

/** The pill's text: the count of several skills, the name of a single one. */
function pillText(
  skills: readonly LoadedSkill[],
  countKey: string,
  t: ReturnType<typeof useChatHost>["t"],
): string {
  return skills.length === 1 ? skills[0]!.name : t(countKey, { n: skills.length });
}

function namesOf(skills: readonly LoadedSkill[]): string {
  return skills.map((skill) => skill.name).join(", ");
}

function SkillNameList({ skills }: { skills: readonly LoadedSkill[] }) {
  return (
    <ul>
      {skills.map((skill) => (
        <li key={skill.packageId}>{skill.name}</li>
      ))}
    </ul>
  );
}

/** The imposed skills, locked in one pill: it opens the picker for who can pick, else is a focusable note. */
function EnforcedPill({ skills, onOpen }: { skills: readonly LoadedSkill[]; onOpen?: () => void }) {
  const { t } = useChatHost();
  const spaceNode = useOriginSpaceNode();
  // The plain name: the node above carries a tile the accessible name must not.
  const spaceLabel =
    useSpaceLabel(useConversationScope().originSpaceId) ?? t("composer.limit.thisSpace");
  const label = t("skills.enforcedPillLabel", { space: spaceLabel, names: namesOf(skills) });
  const body = (
    <>
      <LockIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="max-w-32 truncate">{pillText(skills, "skills.enforcedCount", t)}</span>
    </>
  );
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {onOpen ? (
          <button
            type="button"
            data-testid="skill-pill-enforced"
            aria-label={label}
            onClick={onOpen}
            className={PILL_CLASS}
          >
            {body}
          </button>
        ) : (
          <span
            role="note"
            tabIndex={0}
            data-testid="skill-pill-enforced"
            aria-label={label}
            className={PILL_CLASS}
          >
            {body}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        {sentenceWithNode(t, "skills.enforcedBy", spaceNode)}
        <SkillNameList skills={skills} />
      </TooltipContent>
    </Tooltip>
  );
}

/** The skills the user added, in one pill: it opens the picker, where they are removed. */
function PinnedPill({ skills, onOpen }: { skills: readonly LoadedSkill[]; onOpen: () => void }) {
  const { t } = useChatHost();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="skill-pill-pinned"
          aria-label={t("skills.pinnedPillLabel", { names: namesOf(skills) })}
          onClick={onOpen}
          className={PILL_CLASS}
        >
          <BookOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="max-w-32 truncate">{pillText(skills, "skills.pinnedCount", t)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        <SkillNameList skills={skills} />
      </TooltipContent>
    </Tooltip>
  );
}

interface SkillChipsProps {
  transport: ChatTransport | undefined;
  selection: ChatSkillSelection;
  /** Absent for a member who cannot pick: the pill is then read-only and enforced-only. */
  onOpenPicker?: () => void;
  /** Drawn when no skill is loaded: today's entry to the picker (its summary chip). */
  fallback?: ReactNode;
}

/** The skill pills of the composer's tool row, or `fallback` while no skill is loaded. */
export function SkillChips({
  transport,
  selection,
  onOpenPicker,
  fallback = null,
}: SkillChipsProps) {
  const { t } = useChatHost();
  const { enforced, pinned: allPinned, loading } = useLoadedSkills(transport, selection);
  // Pins are the user's to edit: without the picker, only what the space imposes shows.
  const pinned = onOpenPicker ? allPinned : [];
  // Same footprint as a real pill: no layout shift when the read answers.
  if (loading) return <Skeleton className="h-7 w-28 shrink-0 rounded-full" aria-hidden />;
  if (enforced.length === 0 && pinned.length === 0) return <>{fallback}</>;

  return (
    <div
      role="group"
      aria-label={t("skills.chipsLabel")}
      data-testid="skill-chips"
      className="flex min-w-0 flex-nowrap items-center gap-1.5"
    >
      {enforced.length > 0 && <EnforcedPill skills={enforced} onOpen={onOpenPicker} />}
      {pinned.length > 0 && <PinnedPill skills={pinned} onOpen={onOpenPicker!} />}
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
