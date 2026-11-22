// SPDX-License-Identifier: Apache-2.0

/**
 * The skills the conversation loads, as ONE pill in the composer's tool row: their count, or the
 * single name; the tooltip lists them, then the pins the last turn left out. The pill opens the
 * picker, its X restores the default selection; with discovery off a lock replaces the book.
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
import { useChatHost, type ChatTransport, type ChatTranslate } from "./runtime-context.ts";
import { useChatCommands } from "./use-chat-commands.ts";

interface LoadedSkill {
  packageId: string;
  name: string;
}

/**
 * The conversation's skills (pins and the draft's citations) split into those it loads and the
 * pins the last turn left out, and the server's last verdicts alone for the live region: `null`
 * until the catalogue names them, so a name swap is never read out.
 */
function useSkillsByLoad(
  transport: ChatTransport | undefined,
  skills: ConversationSkills,
  cited: readonly string[],
) {
  const effective = effectiveSkills(skills.pinned, cited);
  const catalogue = useChatCommands(transport, effective.ids.length > 0);
  const names = new Map((catalogue.data?.skills ?? []).map((s) => [s.id, s.name]));
  const named = (id: string): LoadedSkill => ({
    packageId: id,
    name: names.get(id) ?? parseScopedName(id)?.name ?? id,
  });
  const loads = (id: string) => loadsSkill(skillRowState(skills, id, effective.cited));
  const judged = [...skills.stored.values()].filter((pin) => pin.status !== null);
  const injected = judged.filter((pin) => pin.status === "injected").map((pin) => named(pin.id));
  return {
    loaded: effective.ids.filter(loads).map(named),
    refused: effective.ids.filter((id) => !loads(id)).map(named),
    verdicts: catalogue.data
      ? { loaded: injected, refused: judged.length - injected.length }
      : null,
  };
}

/**
 * The single skill's name, how many skills (`countKey`: the pill says « pinned », an accessible
 * name « skills »), or how many are not loaded when none is. The tooltip lists them.
 */
function skillsSummary(
  skills: readonly LoadedSkill[],
  refused: number,
  t: ChatTranslate,
  countKey: "skills.count" | "skills.pinnedCount" = "skills.count",
): string {
  if (skills.length === 0) return t("skills.notLoadedCount", { count: refused });
  return skills.length === 1 ? skills[0]!.name : t(countKey, { count: skills.length });
}

/** What the live region reads out: the skills the last turn loaded, then how many it left out. */
function liveSummary(
  verdicts: { loaded: readonly LoadedSkill[]; refused: number } | null,
  t: ChatTranslate,
): string {
  if (!verdicts) return "";
  const { loaded, refused } = verdicts;
  if (loaded.length === 0) return refused === 0 ? "" : skillsSummary(loaded, refused, t);
  if (refused === 0) return skillsSummary(loaded, 0, t);
  return t("skills.liveSummary", {
    loaded: skillsSummary(loaded, 0, t),
    refused: t("skills.notLoadedCount", { count: refused }),
  });
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
      open={{ onClick, label: t("skills.discoveryOffChip"), testId: "skills-picker-trigger" }}
      removeLabel={t("skills.reset")}
      onRemove={onReset}
      className="shrink-0"
    >
      {t("skills.discoveryOffChip")}
    </RemovableChip>
  );
}

interface SkillChipsProps {
  transport: ChatTransport | undefined;
  skills: ConversationSkills;
  /** The skills the composer's draft cites, counted like the pinned ones. */
  cited: readonly string[];
  onOpenPicker: () => void;
  /** Back to the default selection: the pill's X. */
  onReset: () => void;
}

/** The skill pill, or with no pin the picker's summary chip (drawn only with discovery off). */
export function SkillChips({ transport, skills, cited, onOpenPicker, onReset }: SkillChipsProps) {
  const { t } = useChatHost();
  const { loaded, refused, verdicts } = useSkillsByLoad(transport, skills, cited);
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
          onReset={canResetSkills(skills, cited) ? onReset : undefined}
        />
      )}
      {/* Always mounted, so a verdict landing after a turn is read out. */}
      <span aria-live="polite" data-testid="skill-pill-live" className="sr-only">
        {liveSummary(verdicts, t)}
      </span>
    </>
  );
}
