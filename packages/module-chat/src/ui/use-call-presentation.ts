// SPDX-License-Identifier: Apache-2.0

/**
 * What the thread's cards read off a call's stored part, where the context panel reads it:
 * assistant-ui's `tool-call` part drops `resultProviderMetadata` (`@assistant-ui/ai-sdk`), so it
 * is read off the AI SDK message behind it (`getExternalStoreMessages`).
 */

import * as React from "react";
import { getExternalStoreMessages, useAuiState, type ThreadMessage } from "@assistant-ui/react";
import { isToolUIPart, type UIMessage } from "ai";
import {
  readAppstrateToolPartMetadata,
  type AppstrateToolPartMetadata,
} from "@appstrate/core/chat-turn-metadata";
import { outcomeSpaceOf } from "./conversation-scope.ts";

/** A call's outcome stamp, parsed once when its result lands. */
export type StoredResult = AppstrateToolPartMetadata;

export type StoredResults = ReadonlyMap<string, StoredResult>;

/** The resolved space rides on the stored part's outcome stamp, success or failure. */
export function cardSpaceOf(card: {
  providerMetadata?: unknown;
  stored?: StoredResult | undefined;
}): string | undefined {
  return outcomeSpaceOf(card.stored, card.providerMetadata);
}

/** The stored parts' `resultProviderMetadata` of the tool calls behind `message`, by call id. */
export function resultMetadataOf(message: ThreadMessage): Map<string, unknown> {
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
 * Keeps the last map while its entries are the same objects: the in-flight message is copied on
 * every chunk, its parts' `resultProviderMetadata` is not, and a fresh map would re-render forever.
 */
function stableResultMetadataSelector() {
  let last: ReadonlyMap<string, unknown> = new Map();
  return (s: { message: ThreadMessage }) => {
    const next = resultMetadataOf(s.message);
    if (!sameEntries(last, next)) last = next;
    return last;
  };
}

/** The current message's stored results, by call id: a new value only when one lands. */
export function useStoredResults(): StoredResults {
  const [select] = React.useState(stableResultMetadataSelector);
  const metadata = useAuiState(select);
  return React.useMemo(() => {
    const results = new Map<string, StoredResult>();
    for (const [id, resultProviderMetadata] of metadata) {
      const outcome = readAppstrateToolPartMetadata(resultProviderMetadata);
      if (outcome) results.set(id, outcome);
    }
    return results;
  }, [metadata]);
}
