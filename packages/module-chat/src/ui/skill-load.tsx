// SPDX-License-Identifier: Apache-2.0

/**
 * A skill the assistant read (its `SKILL.md`), drawn with the chip a user message draws for a
 * cited skill. The read serves the turn that made it and pins nothing; an « Épingler » action
 * pins the skill to the conversation. A failed read is a muted chip whose error is written for
 * the model, never shown. Any other read keeps the generic tool row.
 */

import { useId } from "react";
import { makeAssistantToolUI, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { PinIcon } from "lucide-react";
import { Button } from "@appstrate/ui/components/button";
import { cn } from "@appstrate/ui/cn";
import { SKILL_DIRECTIVE } from "../directives.ts";
import { MAX_PINNED_SKILLS } from "../skills.ts";
import { skillLoadOf, skillLoadState, type SkillLoadState } from "./chat-skills.ts";
import { DirectiveChip } from "./directive-chip.tsx";
import { useChatHost } from "./runtime-context.ts";
import { ToolFallback } from "./tool-fallback.tsx";
import { deriveToolPhase } from "./tool-result.ts";
import { useConversationSkillsContext } from "./use-conversation-skills.ts";

/** What the live region reads out, naming the skill. */
const LIVE_KEY: Record<SkillLoadState, string> = {
  running: "skills.load.live.running",
  read: "skills.load.live.read",
  error: "skills.load.live.error",
};

const CAPTION_KEY: Partial<Record<SkillLoadState, string>> = {
  read: "skills.load.read",
  error: "skills.load.error",
};

const CHIP_CLASS: Record<SkillLoadState, string | undefined> = {
  running: "motion-safe:animate-pulse",
  read: undefined,
  error: "text-muted-foreground border-dashed bg-transparent",
};

type ResourceReadProps = ToolCallMessagePartProps<Record<string, unknown>, unknown>;

/**
 * Pins the skill read to the conversation: offered once the server holds the conversation and
 * while the skill is not pinned; at the cap it stays focusable and says why it cannot.
 */
function PinAction({ skill }: { skill: { packageId: string; name: string } }) {
  const { t } = useChatHost();
  const conversation = useConversationSkillsContext();
  const reasonId = useId();
  if (!conversation?.held) return null;
  const { skills, setPin } = conversation;
  if (skills.pins.some((pin) => pin.id === skill.packageId)) return null;
  const atCap = skills.pins.length >= MAX_PINNED_SKILLS;
  const reason = t("skills.chosenMax", { max: MAX_PINNED_SKILLS });
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-testid="skill-load-pin"
        aria-label={t("skills.load.pinLabel", { name: skill.name })}
        aria-disabled={atCap || undefined}
        aria-describedby={atCap ? reasonId : undefined}
        title={atCap ? reason : undefined}
        onClick={() => {
          if (!atCap) setPin(skill.packageId, true);
        }}
        className={cn("h-6 gap-1 px-1.5 text-xs", atCap && "cursor-not-allowed opacity-50")}
      >
        <PinIcon className="size-3" />
        {t("skills.load.pin")}
      </Button>
      {atCap && (
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
  const caption = CAPTION_KEY[state];
  return (
    <div data-testid="skill-load" data-phase={phase} data-state={state} className="my-1.5 text-sm">
      <span className="flex flex-wrap items-center gap-1.5">
        <DirectiveChip
          directiveType={SKILL_DIRECTIVE}
          directiveId={skill.packageId}
          label={skill.name}
          className={CHIP_CLASS[state]}
        />
        {caption && (
          <span
            aria-hidden="true"
            data-testid="skill-load-state"
            className="text-muted-foreground text-xs"
          >
            {t(caption)}
          </span>
        )}
        {state === "read" && <PinAction skill={skill} />}
      </span>
      {/* Present from the start, so the outcome is read out when it lands. */}
      <span aria-live="polite" data-testid="skill-load-live" className="sr-only">
        {t(LIVE_KEY[state], { name: skill.name })}
      </span>
    </div>
  );
}

/** A resource read: a skill's chip when it reads one, the generic tool row otherwise. */
export function ResourceReadTool(props: ResourceReadProps) {
  const skill = skillLoadOf(props.args);
  return skill ? <SkillLoad skill={skill} props={props} /> : <ToolFallback {...props} />;
}

export const ReadResourceToolUI = makeAssistantToolUI<Record<string, unknown>, unknown>({
  toolName: "read_resource",
  render: ResourceReadTool,
});

export const ReadToolUI = makeAssistantToolUI<Record<string, unknown>, unknown>({
  toolName: "read",
  render: ResourceReadTool,
});
