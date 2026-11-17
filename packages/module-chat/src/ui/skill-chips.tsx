// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the user chose for the conversation, as ONE pill in the composer's tool row. It shows
 * its count, or the name when there is a single skill; the tooltip lists the names. Removal
 * happens in the picker, which the pill opens.
 */

import { BookOpenIcon } from "lucide-react";
import { parseScopedName } from "@appstrate/core/naming";
import { badgeVariants } from "@appstrate/ui/components/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { cn } from "@appstrate/ui/cn";
import { injectsSkills, type ChatSkillSelection } from "../skills.ts";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { SkillsChip } from "./skills-picker.tsx";
import { useSkillCatalogue } from "./use-skill-catalogue.ts";

interface LoadedSkill {
  packageId: string;
  name: string;
}

/**
 * What the conversation loads: the user's own pins, counted only in a mode that injects them
 * (`auto` keeps them but uses none). The catalogue is read only to name pins, so only when there are.
 */
function useLoadedSkills(transport: ChatTransport | undefined, selection: ChatSkillSelection) {
  const pinnedIds = injectsSkills(selection.skillMode) ? selection.pinnedSkills : [];
  const catalogue = useSkillCatalogue(transport, pinnedIds.length > 0);
  const names = new Map((catalogue.data ?? []).map((s) => [s.packageId, s.display_name]));
  // Named by the package's bare name until the catalogue answers.
  return pinnedIds.map((id): LoadedSkill => ({
    packageId: id,
    name: names.get(id) ?? parseScopedName(id)?.name ?? id,
  }));
}

const PILL_CLASS = cn(
  badgeVariants({ variant: "secondary" }),
  "text-muted-foreground h-7 min-w-0 shrink gap-1.5 px-2.5 py-0 font-normal",
);

type Translate = ReturnType<typeof useChatHost>["t"];

/** The pill's text: the count of several skills, the name of a single one. */
function pillText(skills: readonly LoadedSkill[], t: Translate): string {
  return skills.length === 1 ? skills[0]!.name : t("skills.pinnedCount", { n: skills.length });
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

/** The skills the user chose, in one pill: it opens the picker, where they are removed. */
function PinnedPill({ skills, onOpen }: { skills: readonly LoadedSkill[]; onOpen: () => void }) {
  const { t } = useChatHost();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          data-testid="skill-pill-pinned"
          aria-label={t("skills.pinnedPillLabel", { skills: skillsSummary(skills, t) })}
          onClick={onOpen}
          className={PILL_CLASS}
        >
          <BookOpenIcon className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="max-w-32 truncate">{pillText(skills, t)}</span>
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
  onOpenPicker: () => void;
}

/**
 * The skill pill of the composer's tool row. While no skill is chosen, the picker's summary chip
 * stands in (drawn only off the default selection).
 */
export function SkillChips({ transport, selection, onOpenPicker }: SkillChipsProps) {
  const pinned = useLoadedSkills(transport, selection);
  if (pinned.length === 0) return <SkillsChip selection={selection} onClick={onOpenPicker} />;
  return <PinnedPill skills={pinned} onOpen={onOpenPicker} />;
}
