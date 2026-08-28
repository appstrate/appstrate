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
 * turn carrying no category degrades to the generic failure rather than to
 * anything provider-shaped.
 */
export function turnErrorState(
  message: AssistantState["message"],
  t: ChatTranslate,
): TurnErrorState | null {
  const turn = turnMetadataFromMessage(sourceMessage(message));
  // A turn cut by the wall-clock ceiling can ALSO have been failing upstream
  // the whole time: `closePiTurn` classifies and persists the cause whatever
  // the finish reason, and reading the category only under `"error"` left the
  // user with "time limit reached" and NOTHING about the 503s or the dead
  // credential behind it.
  //
  // The two sentences COMPOSE rather than replace each other, with no new i18n
  // key: the deadline notice is a REAL persisted text part (`turnNoticeChunks`)
  // rendered in the message body, and this alert sits under it — so the cause
  // is added below the notice, never a second copy of the notice itself.
  //
  // A deadline with NO category adds nothing: nothing failed, and the generic
  // "generation failed" sentence would contradict a notice that says the turn
  // was cut mid-work. Hence the category is required for that branch, while the
  // `"error"` branch degrades a category-less turn to `unknown`.
  if (
    turn?.finishReason === "error" ||
    (turn?.finishReason === "deadline" && turn.errorCategory !== undefined)
  ) {
    return {
      // `errorCategory` is OPTIONAL on the persisted shape — it is stamped only
      // on a turn that carried an error, so the type forces a default here and
      // the compiler rejects the bare index. Not a legacy accommodation: the
      // `"deadline"` disjunct above has already proved it present, but a
      // disjunction narrows nothing, and the metadata is read back out of
      // unvalidated JSONB either way.
      text: t(TURN_ERROR_KEY[turn.errorCategory ?? "unknown"]),
      // Retry is a property of the CAUSE, not of the ceiling: a deadline turn
      // whose cause was rate limiting is retryable, one whose credential is
      // dead is not. Read the persisted verdict either way.
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
