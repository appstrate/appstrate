// SPDX-License-Identifier: Apache-2.0

/**
 * What a failed turn says — derived from the message alone, no React.
 *
 * Split out of `MessageError` ON PURPOSE. That component reads its data through
 * `useAuiState`, whose selector IS `useSyncExternalStore`'s `getSnapshot`: its
 * return value is compared to the previous snapshot with `Object.is` after
 * every commit, so a fresh object literal never compares equal and React
 * re-renders forever — the page then dies with "Maximum update depth exceeded",
 * which is what used to happen on EVERY errored turn.
 *
 * Keeping the derivation here leaves the selector as `(s) => s.message`, a
 * plain field read with nowhere for that shape to come back, and makes the
 * mapping testable without mounting assistant-ui.
 */

import type { AssistantState } from "@assistant-ui/react";
import { getExternalStoreMessages } from "@assistant-ui/react";
import { turnMetadataFromMessage } from "@appstrate/core/chat-turn-metadata";

import { clientTurnErrorFromMarker, refusalCode } from "../turn-error.ts";
import type { ChatTranslate } from "./runtime-context.ts";

/**
 * The ORIGINAL AI-SDK message behind an assistant-ui message. assistant-ui
 * normalizes `ThreadMessage.metadata` to its own shape ({custom, steps, …}) and
 * DROPS unknown keys — so the persisted `appstrate` turn metadata is only
 * reachable on the source message. Falls back to the message itself when no
 * source is bound.
 */
export function sourceMessage(m: unknown): unknown {
  return (getExternalStoreMessages(m as never) as unknown[])[0] ?? m;
}

const TURN_ERROR_KEY = {
  credential_unavailable: "turn.error.credentialUnavailable",
  rate_limited: "turn.error.rateLimited",
  upstream_unavailable: "turn.error.upstreamUnavailable",
  invalid_request: "turn.error.invalidRequest",
  unknown: "turn.error.unknown",
} as const;

/**
 * Sentences for the refusals a turn can be denied with BEFORE the stream opens.
 * A refused turn is not a model failure — "check the model configuration" would
 * send the user to the wrong screen — so each code gets its own copy. Keyed by
 * the wire code, loosely: a code we have no sentence for degrades to the
 * generic failure rather than rendering a missing i18n key.
 */
const REFUSAL_ERROR_KEY: Record<string, string> = {
  quota_exceeded: "turn.error.quotaExceeded",
  subscription_blocked: "turn.error.subscriptionBlocked",
  needs_reconnection: "turn.error.needsReconnection",
};

interface TurnErrorState {
  text: string;
  retryable: boolean;
  requestId: string | undefined;
}

/**
 * `null` when the turn did not fail. Two sources, in order of durability: the
 * persisted provider-neutral category, which survives reload, then the
 * transient assistant-ui error for a failure that never reached a finish chunk.
 *
 * Every path localizes a category — the client never renders provider text. A
 * turn persisted before the category existed carries none, so it degrades to
 * the generic failure instead of surfacing the raw upstream string its
 * `errorText` used to hold.
 */
export function turnErrorState(
  message: AssistantState["message"],
  t: ChatTranslate,
): TurnErrorState | null {
  const turn = turnMetadataFromMessage(sourceMessage(message));
  if (turn?.finishReason === "error") {
    return {
      text: t(TURN_ERROR_KEY[turn.errorCategory ?? "unknown"]),
      retryable: turn.errorRetryable !== false,
      requestId: turn.requestId,
    };
  }

  if (message.status?.type === "incomplete" && message.status.reason === "error") {
    const err = message.status.error;
    // An in-stream failure carries our marker; a turn refused BEFORE the stream
    // opened carries the RFC 9457 body the transport throws verbatim, whose
    // `code` we localize here. A refusal names an action the user must take, so
    // retrying cannot clear it.
    const classified = clientTurnErrorFromMarker(err);
    const code = classified ? undefined : refusalCode(err);
    const refusalKey = code ? REFUSAL_ERROR_KEY[code] : undefined;
    return {
      text: classified
        ? t(TURN_ERROR_KEY[classified.category])
        : refusalKey
          ? t(refusalKey)
          : t("turn.error.unknown"),
      retryable: classified?.retryable ?? refusalKey === undefined,
      // The marker carries a category and nothing else; a request id only ever
      // reaches the client through the persisted turn metadata above.
      requestId: undefined,
    };
  }

  return null;
}
