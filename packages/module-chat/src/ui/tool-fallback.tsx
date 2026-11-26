// SPDX-License-Identifier: Apache-2.0

/**
 * Default rendering for any MCP tool call with no dedicated rich card: the same
 * compact, error-aware row as the modeled tools (raw input/output JSON in a
 * modal on click), shown as the context panel shows the same call (`showCall`):
 * from the platform's presentation once the result landed, else the tool's own name.
 */

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { ToolCallCard } from "./tool-uis.tsx";
import { callSpaceOf } from "./conversation-scope.ts";
import { deriveToolPhase } from "./tool-result.ts";
import { useChatHost } from "./runtime-context.ts";
import { showCall } from "./tool-presentation.ts";
import { useCallPresentation } from "./use-call-presentation.ts";

export const ToolFallback: ToolCallMessagePartComponent = (props) => {
  const { t } = useChatHost();
  const presentation = useCallPresentation(props.toolCallId);
  return (
    <ToolCallCard
      phase={deriveToolPhase(props)}
      {...showCall({ ...props, presentation }, t)}
      args={props.args}
      result={props.result}
      isError={props.isError}
      toolCallId={props.toolCallId}
      timing={props.timing}
      spaceId={callSpaceOf(props)}
    />
  );
};
