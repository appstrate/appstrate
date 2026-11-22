// SPDX-License-Identifier: Apache-2.0

/**
 * A skill the assistant loaded (a read of its `SKILL.md`), drawn with the chip a user message
 * draws for a cited skill. A failed read only says the skill is not loaded: its error is written
 * for the model. Any other read keeps the generic tool row.
 */

import { makeAssistantToolUI, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { SKILL_DIRECTIVE } from "../directives.ts";
import { skillLoadOf } from "./chat-skills.ts";
import { DirectiveChip } from "./directive-chip.tsx";
import { useChatHost } from "./runtime-context.ts";
import { ToolFallback } from "./tool-fallback.tsx";
import { deriveToolPhase, type ToolPhase } from "./tool-result.ts";

const STATE_KEY: Record<ToolPhase, string> = {
  pending: "skills.load.running",
  running: "skills.load.running",
  success: "skills.load.done",
  error: "skills.load.refused",
};

type ResourceReadProps = ToolCallMessagePartProps<Record<string, unknown>, unknown>;

function SkillLoad({
  skill,
  props,
}: {
  skill: { packageId: string; name: string };
  props: ResourceReadProps;
}) {
  const { t } = useChatHost();
  const phase = deriveToolPhase(props);
  const failed = phase === "error";
  return (
    <div data-testid="skill-load" data-phase={phase} className="my-1.5 text-sm">
      <DirectiveChip
        directiveType={SKILL_DIRECTIVE}
        directiveId={skill.packageId}
        label={skill.name}
        className={
          failed
            ? "text-muted-foreground border-dashed bg-transparent"
            : phase === "success"
              ? undefined
              : "motion-safe:animate-pulse"
        }
      />
      {/* One live region, present from the start: its text changes as the load lands. A failure
          is shown; the other states are for screen readers only. */}
      <span
        aria-live="polite"
        data-testid="skill-load-state"
        className={failed ? "text-muted-foreground mt-1 block text-xs" : "sr-only"}
      >
        {t(STATE_KEY[phase])}
      </span>
    </div>
  );
}

/** A resource read: a skill's chip when it loads one, the generic tool row otherwise. */
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
