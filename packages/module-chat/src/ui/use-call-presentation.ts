// SPDX-License-Identifier: Apache-2.0

/**
 * The platform's presentation of a call in the thread, read where the context panel reads it: on
 * the stored tool part (`callPresentation`). assistant-ui's `tool-call` part does not carry it:
 * `@assistant-ui/ai-sdk` forwards a part's `callProviderMetadata` as `providerMetadata` and turns
 * a failure into `{ error: errorText }`, dropping `resultProviderMetadata`. So the card reads the
 * AI SDK message the assistant-ui one was converted from (`getExternalStoreMessages`).
 *
 * What is selected from the store is the stored part's `resultProviderMetadata`, never the message:
 * the in-flight message is replaced on every chunk, and its parts are copied with it
 * (`ReactChatState.replaceMessage` in `@ai-sdk/react` snapshots `{ ...part }`), but a part's
 * `resultProviderMetadata` is the object its result chunk set (`updateToolPart` in `ai`), kept by
 * that shallow copy. A card therefore re-renders when its own call's result lands, not per chunk.
 */

import * as React from "react";
import { getExternalStoreMessages, useAuiState, type ThreadMessage } from "@assistant-ui/react";
import { isToolUIPart, type UIMessage } from "ai";
import type { ToolPresentation } from "@appstrate/core/mcp-presentation";
import { callPresentation } from "./tool-presentation.ts";

/** The stored tool part of the call `toolCallId`, in the AI SDK messages behind `message`. */
export function sourceToolPart(message: ThreadMessage, toolCallId: string) {
  for (const source of getExternalStoreMessages<UIMessage>(message)) {
    for (const part of source.parts) {
      if (isToolUIPart(part) && part.toolCallId === toolCallId) return part;
    }
  }
  return undefined;
}

/** The stored parts' `resultProviderMetadata` of the tool calls behind `message`, by call id. */
function resultMetadataOf(message: ThreadMessage): Map<string, unknown> {
  const metadata = new Map<string, unknown>();
  for (const source of getExternalStoreMessages<UIMessage>(message)) {
    for (const part of source.parts) {
      if (isToolUIPart(part) && "resultProviderMetadata" in part) {
        metadata.set(part.toolCallId, part.resultProviderMetadata);
      }
    }
  }
  return metadata;
}

function sameEntries(a: ReadonlyMap<string, unknown>, b: ReadonlyMap<string, unknown>): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

/**
 * A selector of the message's result metadata ({@link resultMetadataOf}) that returns the map it
 * returned last while its entries are the same objects: a selector returning a fresh map would
 * re-render forever (`turn-error-state.ts`). One per hook instance.
 */
function stableResultMetadataSelector() {
  let last: ReadonlyMap<string, unknown> = new Map();
  return (s: { message: ThreadMessage }) => {
    const next = resultMetadataOf(s.message);
    if (!sameEntries(last, next)) last = next;
    return last;
  };
}

/**
 * The presentations of the current message's calls, by call id, as one value that changes only
 * when a call's result metadata does.
 */
export function useCallPresentations(): ReadonlyMap<string, ToolPresentation> {
  const [select] = React.useState(stableResultMetadataSelector);
  const metadata = useAuiState(select);
  return React.useMemo(() => {
    const presentations = new Map<string, ToolPresentation>();
    for (const [id, value] of metadata) {
      const presentation = callPresentation({ resultProviderMetadata: value });
      if (presentation) presentations.set(id, presentation);
    }
    return presentations;
  }, [metadata]);
}

/** The presentation of the call `toolCallId` of the current message. */
export function useCallPresentation(toolCallId: string): ToolPresentation | undefined {
  const metadata = useAuiState((s) => {
    const part = sourceToolPart(s.message, toolCallId);
    return part && "resultProviderMetadata" in part ? part.resultProviderMetadata : undefined;
  });
  return React.useMemo(() => callPresentation({ resultProviderMetadata: metadata }), [metadata]);
}
