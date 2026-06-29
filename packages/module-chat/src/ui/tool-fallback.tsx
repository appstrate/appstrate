// SPDX-License-Identifier: Apache-2.0

/**
 * Default rendering for any MCP tool call with no dedicated rich card: the same
 * compact, error-aware row as the modeled tools (raw input/output JSON in a
 * modal on click), with a generic icon and the tool name as label.
 */

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { WrenchIcon } from "lucide-react";
import { ToolCallCard } from "./tool-uis.tsx";
import { deriveToolPhase } from "./tool-result.ts";

export const ToolFallback: ToolCallMessagePartComponent = (props) => (
  <ToolCallCard
    phase={deriveToolPhase(props)}
    Icon={WrenchIcon}
    label={props.toolName}
    args={props.args}
    result={props.result}
    isError={props.isError}
    toolCallId={props.toolCallId}
    artifact={props.artifact}
    timing={props.timing}
  />
);
