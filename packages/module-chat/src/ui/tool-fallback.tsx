// SPDX-License-Identifier: Apache-2.0

/** Default rendering for an MCP tool call: a collapsible card with args/result. */

import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { CollapsibleToolCard } from "./collapsible-tool-card.tsx";

export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => (
  <CollapsibleToolCard
    running={status.type === "running"}
    header={
      <>
        <span className="text-muted-foreground">tool</span>{" "}
        <span className="font-medium">{toolName}</span>
      </>
    }
  >
    <div className="space-y-2 border-t px-3 py-2 text-xs">
      <pre className="text-muted-foreground overflow-x-auto whitespace-pre-wrap">{argsText}</pre>
      {result !== undefined && (
        <pre className="overflow-x-auto border-t pt-2 whitespace-pre-wrap">
          {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
        </pre>
      )}
    </div>
  </CollapsibleToolCard>
);
