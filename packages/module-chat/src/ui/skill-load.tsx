// SPDX-License-Identifier: Apache-2.0

/**
 * A skill the assistant read (its `SKILL.md`), drawn with the chip a user message draws for a
 * cited skill, in view under its activity group's line. The read serves the turn that made it and
 * pins nothing; an « Épingler » action pins the skill to the conversation. A failed read is a muted chip whose error is written for
 * the model, never shown.
 */

import { useId } from "react";
import { PinIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { SKILL_DIRECTIVE } from "../directives.ts";
import {
  effectiveSkills,
  exceedsBudget,
  pinIds,
  skillBudget,
  skillLoadOf,
  skillLoadState,
  type SkillLoadState,
} from "./chat-skills.ts";
import { DirectiveChip } from "./directive-chip.tsx";
import { useChatHost } from "./runtime-context.ts";
import type { ToolPartProps } from "./tool-uis.tsx";
import { deriveToolPhase } from "./tool-result.ts";
import { useChatCommands } from "./use-chat-commands.ts";
import { useConversationSkillsContext } from "./use-conversation-skills.ts";

const CHIP_CLASS: Record<SkillLoadState, string | undefined> = {
  running: "motion-safe:animate-pulse",
  read: undefined,
  error: "text-muted-foreground border-dashed bg-transparent",
};

type ResourceReadProps = ToolPartProps;

/**
 * Pins the skill read to the conversation: offered once the server holds the conversation and
 * while the skill is not pinned. When its listed size would take the pins past their budget it
 * stays focusable and says why it cannot; an unlisted size pins.
 */
function PinAction({ skill }: { skill: { packageId: string; name: string } }) {
  const { t } = useChatHost();
  const conversation = useConversationSkillsContext();
  const catalogue = useChatCommands(!!conversation?.held);
  const reasonId = useId();
  if (!conversation?.held) return null;
  const { skills, setPin } = conversation;
  if (skills.pins.some((pin) => pin.id === skill.packageId)) return null;
  const listed = catalogue.data?.skills ?? [];
  const budget = skillBudget(skills, effectiveSkills(pinIds(skills), []), listed);
  const bytes = listed.find((s) => s.id === skill.packageId)?.bytes ?? null;
  const overBudget = exceedsBudget(budget, bytes);
  const reason = t("skills.budget.wouldExceed");
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="skill-load-pin"
        aria-label={t("skills.load.pinLabel", { name: skill.name })}
        aria-describedby={overBudget ? reasonId : undefined}
        title={overBudget ? reason : undefined}
        onClick={() => setPin(skill.packageId, true)}
        className="h-6 gap-1 px-1.5 text-xs"
      >
        <PinIcon className="size-3" />
        {t("skills.load.pin")}
      </Button>
      {overBudget && (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      )}
    </>
  );
}

function SkillLoad({
  skill,
  props,
}: {
  skill: { packageId: string; name: string };
  props: ResourceReadProps;
}) {
  const { t } = useChatHost();
  const phase = deriveToolPhase(props);
  const state = skillLoadState(phase);
  return (
    <div data-testid="skill-load" data-phase={phase} data-state={state} className="my-1 text-sm">
      <span className="flex flex-wrap items-center gap-1.5">
        <DirectiveChip
          directiveType={SKILL_DIRECTIVE}
          directiveId={skill.packageId}
          label={skill.name}
          className={CHIP_CLASS[state]}
        />
        {state !== "running" && (
          <span
            aria-hidden="true"
            data-testid="skill-load-state"
            className="text-muted-foreground text-xs"
          >
            {t(state === "read" ? "skills.load.read" : "skills.load.error")}
          </span>
        )}
        {state === "read" && <PinAction skill={skill} />}
      </span>
      {/* Present from the start, so the outcome is read out when it lands. */}
      <span aria-live="polite" data-testid="skill-load-live" className="sr-only">
        {t(`skills.load.live.${state}`, { name: skill.name })}
      </span>
    </div>
  );
}

/** The chip of the skill a read loaded, in view under its group's line; nothing for any other read. */
export function SkillReadBreakout(props: ResourceReadProps) {
  const skill = skillLoadOf(props.args);
  return skill ? <SkillLoad skill={skill} props={props} /> : null;
}
