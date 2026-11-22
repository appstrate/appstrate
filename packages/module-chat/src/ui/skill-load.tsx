// SPDX-License-Identifier: Apache-2.0

/**
 * A skill the assistant read (its `SKILL.md`), drawn with the chip a user message draws for a
 * cited skill. It says "loaded" only when the server pinned it ({@link skillLoadState}); a read it
 * did not pin, or a failed one, is muted and captioned. A failed read's error is written for the
 * model, never shown. Any other read keeps the generic tool row.
 */

import { makeAssistantToolUI, type ToolCallMessagePartProps } from "@assistant-ui/react";
import { SKILL_DIRECTIVE } from "../directives.ts";
import { skillLoadOf, skillLoadState, type SkillLoadState } from "./chat-skills.ts";
import { DirectiveChip } from "./directive-chip.tsx";
import { useChatHost } from "./runtime-context.ts";
import { ToolFallback } from "./tool-fallback.tsx";
import { deriveToolPhase } from "./tool-result.ts";

/** What the live region reads out, naming the skill. */
const LIVE_KEY: Record<SkillLoadState, string> = {
  running: "skills.load.live.running",
  loaded: "skills.load.live.loaded",
  readOnly: "skills.load.live.readOnly",
  refused: "skills.load.live.refused",
};

/** The caption shown under the chip, beside its name: only for a skill left unpinned. */
const CAPTION_KEY: Partial<Record<SkillLoadState, string>> = {
  readOnly: "skills.load.readOnly",
  refused: "skills.load.refused",
};

const CHIP_CLASS: Record<SkillLoadState, string | undefined> = {
  running: "motion-safe:animate-pulse",
  loaded: undefined,
  readOnly: "border-dashed",
  refused: "text-muted-foreground border-dashed bg-transparent",
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
  const state = skillLoadState(phase, props.result);
  const caption = CAPTION_KEY[state];
  return (
    <div data-testid="skill-load" data-phase={phase} data-state={state} className="my-1.5 text-sm">
      <DirectiveChip
        directiveType={SKILL_DIRECTIVE}
        directiveId={skill.packageId}
        label={skill.name}
        className={CHIP_CLASS[state]}
      />
      {/* Present from the start, so the outcome is read out when it lands. */}
      <span aria-live="polite" data-testid="skill-load-live" className="sr-only">
        {t(LIVE_KEY[state], { name: skill.name })}
      </span>
      {caption && (
        <span
          aria-hidden="true"
          data-testid="skill-load-state"
          className="text-muted-foreground mt-1 block text-xs"
        >
          {t(caption)}
        </span>
      )}
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
