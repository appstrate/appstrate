// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the conversation loads, as ONE pill in the composer's tool row. It shows its count, or
 * the name when there is a single skill; the tooltip lists the names, then the pins the last turn
 * left out (never counted as loaded). Removal happens in the picker, which the pill opens; its X
 * restores the default selection. With discovery off a lock replaces the book.
 */

import { BookOpenIcon, LockIcon } from "lucide-react";
import { parseScopedName } from "@appstrate/core/naming";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import {
  canResetSkills,
  effectiveSkills,
  loadsSkill,
  skillRowState,
  type ConversationSkills,
} from "./chat-skills.ts";
import { RemovableChip } from "./removable-chip.tsx";
import { useChatHost, type ChatTransport } from "./runtime-context.ts";
import { SkillsChip } from "./skills-picker.tsx";
import { useChatCommands } from "./use-chat-commands.ts";

const NO_CITED: readonly string[] = [];

interface LoadedSkill {
  packageId: string;
  name: string;
}

/**
 * The conversation's skills split by what the server reported: those it loads (pins and the
 * draft's citations) and the pins the last turn left out. The catalogue is read only to name
 * them, so only when there are.
 */
function useSkillsByLoad(
  transport: ChatTransport | undefined,
  skills: ConversationSkills,
  cited: readonly string[],
) {
  const effective = effectiveSkills(skills.pinned, cited);
  const catalogue = useChatCommands(transport, effective.ids.length > 0);
  const names = new Map((catalogue.data?.skills ?? []).map((s) => [s.id, s.name]));
  // Named by the package's bare name until the catalogue answers.
  const named = (id: string): LoadedSkill => ({
    packageId: id,
    name: names.get(id) ?? parseScopedName(id)?.name ?? id,
  });
  const loads = (id: string) => loadsSkill(skillRowState(skills, id, effective.cited));
  return {
    loaded: effective.ids.filter(loads).map(named),
    refused: effective.ids.filter((id) => !loads(id)).map(named),
  };
}

type Translate = ReturnType<typeof useChatHost>["t"];

/** The pill's text: the count of several skills, the name of a single one, or how many are not loaded when none is. */
function pillText(skills: readonly LoadedSkill[], refused: number, t: Translate): string {
  if (skills.length === 0) return t("skills.notLoadedCount", { count: refused });
  return skills.length === 1 ? skills[0]!.name : t("skills.pinnedCount", { n: skills.length });
}

/** What the accessible name says of the skills: the single name, or how many. The tooltip lists them. */
function skillsSummary(skills: readonly LoadedSkill[], refused: number, t: Translate): string {
  if (skills.length === 0) return t("skills.notLoadedCount", { count: refused });
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

/** The pins the last turn left out, under the loaded ones: pinned, not in the model's context. */
function RefusedSkillList({ skills }: { skills: readonly LoadedSkill[] }) {
  const { t } = useChatHost();
  if (skills.length === 0) return null;
  return (
    <div className="mt-1">
      <p className="font-medium">{t("skills.state.notLoaded", { count: skills.length })}</p>
      <SkillNameList skills={skills} />
    </div>
  );
}

/**
 * The skills the user chose, in one pill: its body opens the picker, where they are removed; its X
 * restores the default selection (no pin, discovery on).
 */
function PinnedPill({
  skills,
  refused,
  discovery,
  onOpen,
  onReset,
}: {
  skills: readonly LoadedSkill[];
  refused: readonly LoadedSkill[];
  discovery: boolean;
  onOpen: () => void;
  /** Absent when there is nothing to restore (only cited skills, discovery on). */
  onReset?: () => void;
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
              skills: skillsSummary(skills, refused.length, t),
            }),
            testId: "skill-pill-pinned",
          }}
          removeLabel={t("skills.reset")}
          onRemove={onReset}
        >
          {pillText(skills, refused.length, t)}
        </RemovableChip>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-xs">
        <SkillNameList skills={skills} />
        <RefusedSkillList skills={refused} />
        {!discovery && <p className="mt-1">{t("skills.discoveryOffChip")}</p>}
      </TooltipContent>
    </Tooltip>
  );
}

interface SkillChipsProps {
  transport: ChatTransport | undefined;
  skills: ConversationSkills;
  /** The skills the composer's draft cites: counted and named like the pinned ones. */
  cited?: readonly string[];
  onOpenPicker: () => void;
  /** Back to the default selection: the pill's X. */
  onReset: () => void;
}

/**
 * The skill pill of the composer's tool row, drawn when the selection departs from the default:
 * with pins, even when the last turn left every one out. With no pin at all, the picker's summary
 * chip stands in (drawn only with discovery off).
 */
export function SkillChips({
  transport,
  skills,
  cited = NO_CITED,
  onOpenPicker,
  onReset,
}: SkillChipsProps) {
  const { loaded, refused } = useSkillsByLoad(transport, skills, cited);
  if (loaded.length === 0 && refused.length === 0) {
    return (
      <SkillsChip discovery={skills.skillDiscovery} onClick={onOpenPicker} onReset={onReset} />
    );
  }
  return (
    <PinnedPill
      skills={loaded}
      refused={refused}
      discovery={skills.skillDiscovery}
      onOpen={onOpenPicker}
      onReset={canResetSkills(skills, cited) ? onReset : undefined}
    />
  );
}
