// SPDX-License-Identifier: Apache-2.0

/**
 * Default rendering for any MCP tool call with no dedicated rich card: the same
 * compact, error-aware row as the modeled tools (raw input/output JSON in a
 * modal on click). Its label is the tool's translated name (`tool.name.<tool>`),
 * else the title the platform presented it under, else the tool name; its glyph
 * is what the call acted on (`get_me`: the user) when the platform names it.
 */

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { WrenchIcon } from "lucide-react";
import { ToolCallCard } from "./tool-uis.tsx";
import { callSpaceOf } from "./conversation-scope.ts";
import { deriveToolPhase } from "./tool-result.ts";
import { useChatHost } from "./runtime-context.ts";
import { presentationOf, presentCall } from "./tool-presentation.ts";

export const ToolFallback: ToolCallMessagePartComponent = (props) => {
  const { t } = useChatHost();
  const presentation = presentationOf(props.result);
  const ownLabel = t(`tool.name.${props.toolName}`, {
    defaultValue: presentation?.title ?? props.toolName,
  });
  const presented = presentation ? presentCall(presentation, t, ownLabel) : undefined;
  return (
    <ToolCallCard
      phase={deriveToolPhase(props)}
      Icon={presented?.Icon ?? WrenchIcon}
      subject={presented?.subject}
      label={presented?.label ?? ownLabel}
      idText={presented?.idText}
      args={props.args}
      result={props.result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      timing={props.timing}
      spaceId={callSpaceOf(props)}
    />
  );
};
