// SPDX-License-Identifier: Apache-2.0

/**
 * Default rendering for any MCP tool call with no dedicated rich card: the same
 * compact, error-aware row as the modeled tools (raw input/output JSON in a
 * modal on click), named as the context panel names the same call (`showCall`).
 */

import { ToolCallCard, type ToolCardProps } from "./tool-uis.tsx";
import { cardSpaceOf } from "./use-call-presentation.ts";
import { deriveToolPhase } from "./tool-result.ts";
import { useChatHost } from "./runtime-context.ts";
import { showCall } from "./tool-presentation.ts";

export function ToolFallback(props: ToolCardProps) {
  const { t } = useChatHost();
  return (
    <ToolCallCard
      phase={deriveToolPhase(props)}
      {...showCall({ ...props, presentation: props.stored?.presentation }, t)}
      args={props.args}
      result={props.result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      stored={props.stored}
      spaceId={cardSpaceOf(props)}
    />
  );
}
