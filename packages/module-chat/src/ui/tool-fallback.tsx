// SPDX-License-Identifier: Apache-2.0

/**
 * Default rendering for any MCP tool call with no dedicated rich card: the same
 * compact, error-aware row as the modeled tools (raw input/output JSON in a
 * modal on click), named as the context panel names it (`toolPresentation`).
 */

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { presented, ToolCallCard } from "./tool-uis.tsx";
import { callSpaceOf } from "./conversation-scope.ts";
import { deriveToolPhase } from "./tool-result.ts";

export const ToolFallback: ToolCallMessagePartComponent = (props) => (
  <ToolCallCard
    phase={deriveToolPhase(props)}
    {...presented(props)}
    args={props.args}
    result={props.result}
    isError={props.isError}
    toolCallId={props.toolCallId}
    timing={props.timing}
    spaceId={callSpaceOf(props)}
  />
);
