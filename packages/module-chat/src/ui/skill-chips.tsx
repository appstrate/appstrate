// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the user chose for the conversation, as ONE pill in the composer's tool row. It shows
 * its count, or the name when there is a single skill; the tooltip lists the names. Removal
 * happens in the picker, which the pill opens; its X returns to the automatic mode.
 */

import { BookOpenIcon } from "lucide-react";
import { parseScopedName } from "@appstrate/core/naming";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import { injectsSkills, type ChatSkillSelection } from "../skills.ts";
import { RemovableChip } from "./removable-chip.tsx";
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

/**
 * The skills the user chose, in one pill: its body opens the picker, where they are removed; its X
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
          {pillText(skills, t)}
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
  onOpenPicker: () => void;
  /** Back to the automatic mode: the pill's X. */
  onResetMode: () => void;
}

/**
 * The skill pill of the composer's tool row. While no skill is chosen, the picker's summary chip
 * stands in (drawn only off the automatic mode).
 */
export function SkillChips({ transport, selection, onOpenPicker, onResetMode }: SkillChipsProps) {
  const pinned = useLoadedSkills(transport, selection);
  if (pinned.length === 0) {
    return <SkillsChip selection={selection} onClick={onOpenPicker} onReset={onResetMode} />;
  }
  return <PinnedPill skills={pinned} onOpen={onOpenPicker} onReset={onResetMode} />;
}
