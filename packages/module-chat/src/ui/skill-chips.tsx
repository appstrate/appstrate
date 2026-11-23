// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the conversation loads, as ONE pill in the composer's tool row: their count, or the
 * single name; the tooltip lists them, then the pins the last turn left out. The pill opens the
 * picker, its X restores the default selection; with discovery off a lock replaces the book.
 */

import { BookOpenIcon, LockIcon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@appstrate/ui/components/tooltip";
import {
  canResetSkills,
  loadsSkill,
  skillRowState,
  type EffectiveSkills,
  type StoredSkills,
} from "./chat-skills.ts";
import { RemovableChip } from "./removable-chip.tsx";
import {
  namedSkill,
  skillsSummary,
  verdictsSummary,
  type LoadedSkill,
  type SkillNames,
} from "./skills-summary.ts";
import { useChatHost, type ChatTranslate } from "./runtime-context.ts";
import { useChangeAnnouncement } from "./use-change-announcement.ts";
import { useChatCommands } from "./use-chat-commands.ts";

/**
 * The conversation's skills (pins and the draft's citations) split into those it loads and the
 * pins the last turn left out, and what the live region reads of the server's last verdicts.
 */
function useSkillsByLoad(skills: StoredSkills, effective: EffectiveSkills, t: ChatTranslate) {
  const catalogue = useChatCommands(effective.ids.length > 0);
  const names: SkillNames | null = catalogue.data
    ? new Map(catalogue.data.skills.map((s) => [s.id, s.name]))
    : null;
  const named = (id: string) => namedSkill(names ?? new Map(), id);
  const loads = (id: string) => loadsSkill(skillRowState(skills, id), effective.cited.has(id));
  return {
    loaded: effective.ids.filter(loads).map(named),
    refused: effective.ids.filter((id) => !loads(id)).map(named),
    verdicts: verdictsSummary(skills, names, t),
  };
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

/** The pins the last turn left out, under the loaded ones. */
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
  /** Absent when there is nothing to restore. */
  onReset?: () => void;
}) {
  const { t } = useChatHost();
  const summary = skillsSummary(skills, refused.length, t);
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <RemovableChip
          icon={discovery ? <BookOpenIcon /> : <LockIcon />}
          open={{
            onClick: onOpen,
            label: t(discovery ? "skills.pinnedPillLabel" : "skills.pinnedLockedPillLabel", {
              skills: summary,
            }),
            testId: "skill-pill-pinned",
          }}
          removeLabel={t("skills.reset")}
          onRemove={onReset}
        >
          {skillsSummary(skills, refused.length, t, "skills.pinnedCount")}
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

/**
 * The picker's entry while no skill is pinned: drawn only with discovery off, it reopens the
 * picker, and its X restores the default selection.
 */
function SkillsChip({
  discovery,
  onClick,
  onReset,
}: {
  discovery: boolean;
  onClick: () => void;
  onReset: () => void;
}) {
  const { t } = useChatHost();
  if (discovery) return null;
  return (
    <RemovableChip
      icon={<LockIcon />}
      open={{ onClick, label: t("skills.discoveryOffChip"), testId: "skills-discovery-off-chip" }}
      removeLabel={t("skills.reset")}
      onRemove={onReset}
      className="shrink-0"
    >
      {t("skills.discoveryOffChip")}
    </RemovableChip>
  );
}

interface SkillChipsProps {
  skills: StoredSkills;
  /** The skills the composer's draft cites, counted like the pinned ones. */
  draft: EffectiveSkills;
  onOpenPicker: () => void;
  /** Back to the default selection: the pill's X. */
  onReset: () => void;
}

/** The skill pill, or with no pin the picker's summary chip (drawn only with discovery off). */
export function SkillChips({ skills, draft, onOpenPicker, onReset }: SkillChipsProps) {
  const { t } = useChatHost();
  const { loaded, refused, verdicts } = useSkillsByLoad(skills, draft, t);
  // The verdicts found on opening the conversation are not news: only a later change is read out.
  const announced = useChangeAnnouncement(verdicts ?? "", verdicts !== null);
  return (
    <>
      {loaded.length === 0 && refused.length === 0 ? (
        <SkillsChip discovery={skills.skillDiscovery} onClick={onOpenPicker} onReset={onReset} />
      ) : (
        <PinnedPill
          skills={loaded}
          refused={refused}
          discovery={skills.skillDiscovery}
          onOpen={onOpenPicker}
          onReset={canResetSkills(skills) ? onReset : undefined}
        />
      )}
      {/* Always mounted, so a verdict landing after a turn is read out. */}
      <span aria-live="polite" data-testid="skill-pill-live" className="sr-only">
        {announced}
      </span>
    </>
  );
}
