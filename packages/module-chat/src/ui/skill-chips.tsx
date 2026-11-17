// SPDX-License-Identifier: Apache-2.0

/**
 * The skills loaded in the conversation, as pills in the composer's tool row: ONE locked pill for
 * the ones the origin space imposes (also readable by a member without `skills:read`) and ONE for
 * the ones the user added. Each shows its count, or the name when there is a single skill; the
 * tooltip lists the names. Removal happens in the picker, which both pills open; the user's pill
 * also carries an X back to the automatic mode.
 */

import { BookOpenIcon, LockIcon } from "lucide-react";
import { parseScopedName } from "@appstrate/core/naming";
import { badgeVariants } from "@appstrate/ui/components/badge";
import { Skeleton } from "@appstrate/ui/components/skeleton";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { cn } from "@appstrate/ui/cn";
import { injectsSkills, type ChatSkillSelection } from "../skills.ts";
import { ownPins } from "./chat-skills.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { useOriginSpaceLabel, useOriginSpaceNode } from "./conversation-scope.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { sentenceWithNode } from "./sentence-with-name.tsx";
import { SkillsChip } from "./skills-picker.tsx";
import { useEnforcedSkills } from "./use-enforced-skills.ts";
import { useSkillCatalogue } from "./use-skill-catalogue.ts";

interface LoadedSkill {
  packageId: string;
  name: string;
}

/**
 * What the conversation loads: the origin space's imposed skills and, for who can pick, the user's own
 * pins. Pins count only in a mode that injects them (`auto` keeps them but uses none); an enforced
 * skill is never listed twice. The catalogue is read only to name pins, so only when there are.
 */
function useLoadedSkills(
  transport: ChatTransport | undefined,
  selection: ChatSkillSelection,
  pickable: boolean,
) {
  const enforcedQuery = useEnforcedSkills(transport);
  const enforcedSkills = enforcedQuery.data ?? [];
  const enforcedIds = new Set(enforcedSkills.map((skill) => skill.packageId));
  const pinnedIds =
    pickable && injectsSkills(selection.skillMode)
      ? ownPins(selection.pinnedSkills, enforcedIds)
      : [];
  const catalogue = useSkillCatalogue(transport, pinnedIds.length > 0);
  const names = new Map((catalogue.data ?? []).map((s) => [s.packageId, s.display_name]));
  const enforced: LoadedSkill[] = enforcedSkills.map((s) => ({
    packageId: s.packageId,
    name: s.display_name ?? s.packageId,
  }));
  // Named by the package's bare name until the catalogue answers.
  const pinned: LoadedSkill[] = pinnedIds.map((id) => ({
    packageId: id,
    name: names.get(id) ?? parseScopedName(id)?.name ?? id,
  }));
  // `isLoading`: the read is off without an origin space the chat acts in, and would wait forever.
  return { enforced, pinned, loading: enforcedQuery.isLoading };
}

const PILL_CLASS = cn(
  badgeVariants({ variant: "secondary" }),
  "text-muted-foreground h-7 min-w-0 shrink gap-1.5 px-2.5 py-0 font-normal",
);

type Translate = ReturnType<typeof useChatHost>["t"];

/** The pill's text: the count of several skills, the name of a single one. */
function pillText(skills: readonly LoadedSkill[], countKey: string, t: Translate): string {
  return skills.length === 1 ? skills[0]!.name : t(countKey, { n: skills.length });
}

/** What the accessible name says of the skills: the single name, or how many. The tooltip lists them. */
function skillsSummary(skills: readonly LoadedSkill[], t: Translate): string {
  return skills.length === 1 ? skills[0]!.name : t("skills.count", { n: skills.length });
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
  const space = useOriginSpaceLabel();
  const summary = skillsSummary(skills, t);
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
            aria-label={t("skills.enforcedPillAction", { space, skills: summary })}
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
            aria-label={t("skills.enforcedPillLabel", { space, skills: summary })}
            className={PILL_CLASS}
          >
            {body}
          </span>
        )}
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        <p className="font-medium">{sentenceWithNode(t, "skills.enforcedBy", spaceNode)}</p>
        <SkillNameList skills={skills} />
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * The skills the user added, in one pill: its body opens the picker, where they are removed; its X
 * returns to the automatic mode, which keeps them unused.
 */
function PinnedPill({
  skills,
  onOpen,
  onReset,
}: {
  skills: readonly LoadedSkill[];
  onOpen: () => void;
  onReset: () => void;
}) {
  const { t } = useChatHost();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RemovableChip
          icon={<BookOpenIcon />}
          open={{
            onClick: onOpen,
            label: t("skills.pinnedPillLabel", { skills: skillsSummary(skills, t) }),
            testId: "skill-pill-pinned",
          }}
          removeLabel={t("skills.resetToAuto")}
          onRemove={onReset}
        >
          {pillText(skills, "skills.pinnedCount", t)}
        </RemovableChip>
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
  /**
   * Who can pick: open the picker, or return to the automatic mode (a pill's X). Absent for a member
   * who cannot pick: the pill is then read-only and enforced-only.
   */
  picker?: { onOpen: () => void; onReset: () => void };
}

/**
 * The skill pills of the composer's tool row. While no skill is loaded, who can pick gets the
 * picker's summary chip instead (drawn only off the automatic mode).
 */
export function SkillChips({ transport, selection, picker }: SkillChipsProps) {
  const { t } = useChatHost();
  const { enforced, pinned, loading } = useLoadedSkills(transport, selection, !!picker);
  if (loading) {
    // A placeholder only where something is sure to be drawn once the read answers (the chip
    // of a non-automatic mode) or is the only thing this row is for (no picker): elsewhere the
    // common case draws nothing, and a placeholder would itself be the shift.
    const reserve = !picker || injectsSkills(selection.skillMode);
    return reserve ? <Skeleton className="h-7 w-28 shrink-0 rounded-full" aria-hidden /> : null;
  }
  if (enforced.length === 0 && pinned.length === 0) {
    return picker ? (
      <SkillsChip selection={selection} onClick={picker.onOpen} onReset={picker.onReset} />
    ) : null;
  }

  return (
    <div
      role="group"
      aria-label={t("skills.chipsLabel")}
      data-testid="skill-chips"
      className="flex min-w-0 flex-nowrap items-center gap-1.5"
    >
      {enforced.length > 0 && <EnforcedPill skills={enforced} onOpen={picker?.onOpen} />}
      {picker && pinned.length > 0 && (
        <PinnedPill skills={pinned} onOpen={picker.onOpen} onReset={picker.onReset} />
      )}
    </div>
  );
}
