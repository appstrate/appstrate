// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the user chose for the conversation, as ONE pill in the composer's tool row. It shows
 * its count, or the name when there is a single skill; the tooltip lists the names. Removal
 * happens in the picker, which the pill opens; its X restores the default selection. With
 * discovery off a lock replaces the book.
 */

import { BookOpenIcon, LockIcon } from "lucide-react";
import { parseScopedName } from "@appstrate/core/naming";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import type { ChatSkillSelection } from "../skills.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { SkillsChip } from "./skills-picker.tsx";
import { useSkillCatalogue } from "./use-skill-catalogue.ts";

interface LoadedSkill {
  packageId: string;
  name: string;
}

/** What the conversation loads: the user's pins. The catalogue is read only to name them, so only when there are. */
function useLoadedSkills(transport: ChatTransport | undefined, selection: ChatSkillSelection) {
  const pinnedIds = selection.pinnedSkills;
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
 * restores the default selection (no pin, discovery on).
 */
function PinnedPill({
  skills,
  discovery,
  onOpen,
  onReset,
}: {
  skills: readonly LoadedSkill[];
  discovery: boolean;
  onOpen: () => void;
  onReset: () => void;
}) {
  const { t } = useChatHost();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RemovableChip
          icon={discovery ? <BookOpenIcon /> : <LockIcon />}
          open={{
            onClick: onOpen,
            label: t(discovery ? "skills.pinnedPillLabel" : "skills.pinnedLockedPillLabel", {
              skills: skillsSummary(skills, t),
            }),
            testId: "skill-pill-pinned",
          }}
          removeLabel={t("skills.reset")}
          onRemove={onReset}
        >
          {pillText(skills, t)}
        </RemovableChip>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        <SkillNameList skills={skills} />
        {!discovery && <p className="mt-1">{t("skills.discoveryOffChip")}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

interface SkillChipsProps {
  transport: ChatTransport | undefined;
  selection: ChatSkillSelection;
  onOpenPicker: () => void;
  /** Back to the default selection: the pill's X. */
  onReset: () => void;
}

/**
 * The skill pill of the composer's tool row, drawn when the selection departs from the default.
 * While no skill is pinned, the picker's summary chip stands in (drawn only with discovery off).
 */
export function SkillChips({ transport, selection, onOpenPicker, onReset }: SkillChipsProps) {
  const pinned = useLoadedSkills(transport, selection);
  if (pinned.length === 0) {
    return <SkillsChip selection={selection} onClick={onOpenPicker} onReset={onReset} />;
  }
  return (
    <PinnedPill
      skills={pinned}
      discovery={selection.skillDiscovery}
      onOpen={onOpenPicker}
      onReset={onReset}
    />
  );
}
