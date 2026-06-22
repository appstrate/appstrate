// SPDX-License-Identifier: Apache-2.0

/** Default rendering for an MCP tool call: a collapsible card with args/result. */

import { useState } from "react";
import type { ToolCallMessagePartComponent } from "@assistant-ui/react";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, Loader2Icon } from "lucide-react";

export const ToolFallback: ToolCallMessagePartComponent = ({
  toolName,
  argsText,
  result,
  status,
}) => {
  const [open, setOpen] = useState(false);
  const running = status.type === "running";
  return (
    <div className="bg-card text-card-foreground my-3 w-full rounded-lg border">
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm"
        onClick={() => setOpen((v) => !v)}
      >
        {running ? (
          <Loader2Icon className="text-muted-foreground size-4 shrink-0 animate-spin" />
        ) : (
          <CheckIcon className="text-primary size-4 shrink-0" />
        )}
        <span className="flex-1 truncate">
          <span className="text-muted-foreground">tool</span>{" "}
          <span className="font-medium">{toolName}</span>
        </span>
        {open ? (
          <ChevronUpIcon className="text-muted-foreground size-4" />
        ) : (
          <ChevronDownIcon className="text-muted-foreground size-4" />
        )}
      </button>
      {open && (
        <div className="space-y-2 border-t px-3 py-2 text-xs">
          <pre className="text-muted-foreground overflow-x-auto whitespace-pre-wrap">
            {argsText}
          </pre>
          {result !== undefined && (
            <pre className="overflow-x-auto border-t pt-2 whitespace-pre-wrap">
              {typeof result === "string" ? result : JSON.stringify(result, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};
