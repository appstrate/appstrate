// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's presentation of a call in the thread, read where the context panel reads it: on
 * the stored tool part (`callPresentation`). assistant-ui's `tool-call` part does not carry it:
 * `@assistant-ui/ai-sdk` forwards a part's `callProviderMetadata` as `providerMetadata` and turns
 * a failure into `{ error: errorText }`, dropping `resultProviderMetadata`. So the card reads the
 * AI SDK message the assistant-ui one was converted from (`getExternalStoreMessages`).
 */

import * as React from "react";
import { getExternalStoreMessages, useAuiState } from "@assistant-ui/react";
import { isToolUIPart, type UIMessage } from "ai";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { callPresentation } from "./tool-presentation.ts";

/** The stored tool part of the call `toolCallId`, in the AI SDK messages behind `message`. */
export function sourceToolPart(message: unknown, toolCallId: string) {
  for (const source of getExternalStoreMessages(message as never) as UIMessage[]) {
    for (const part of source.parts) {
      if (isToolUIPart(part) && part.toolCallId === toolCallId) return part;
    }
  }
  return undefined;
}

/** The presentations of the calls `toolCallIds` of the current message, in order. */
export function useCallPresentations(
  toolCallIds: readonly string[],
): (ToolPresentation | undefined)[] {
  // The message, not a derived value: a selector returning a fresh array re-renders forever
  // (`turn-error-state.ts`).
  const message = useAuiState((s) => s.message);
  return React.useMemo(
    () => toolCallIds.map((id) => callPresentation(sourceToolPart(message, id))),
    [message, toolCallIds],
  );
}

/** The presentation of the call `toolCallId` of the current message. */
export function useCallPresentation(toolCallId: string): ToolPresentation | undefined {
  const ids = React.useMemo(() => [toolCallId], [toolCallId]);
  return useCallPresentations(ids)[0];
}
