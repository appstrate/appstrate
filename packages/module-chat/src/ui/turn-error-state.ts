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

import {
  clientTurnErrorFromMarker,
  clientTurnErrorFromRateLimit,
  problemRequestId,
  refusalCode,
  type ClientTurnError,
} from "../turn-error.ts";
import type { ChatCan, ChatTranslate } from "./runtime-context.ts";

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
 * Where a failure only an administrator can clear is fixed. Whoever holds the
 * permission gets the link; anyone else is sent to an administrator. Plain
 * paths: the module never imports the router.
 */
const FIX = {
  billing: {
    permission: "billing:manage",
    label: "turn.error.manageBilling",
    href: "/org-settings/billing",
  },
  models: {
    permission: "model-provider-credentials:write",
    label: "turn.error.manageModels",
    href: "/org-settings/models",
  },
} as const;

/**
 * Sentences for the refusals a turn can be denied with BEFORE the stream opens.
 * A refused turn is not a model failure — "check the model configuration" would
 * send the user to the wrong screen — so each code gets its own copy. Keyed by
 * the wire code, loosely: a code we have no sentence for degrades to the
 * generic failure rather than rendering a missing i18n key.
 */
const REFUSAL: Record<string, { text: string; fix?: keyof typeof FIX }> = {
  quota_exceeded: { text: "turn.error.quotaExceeded", fix: "billing" },
  subscription_blocked: { text: "turn.error.subscriptionBlocked", fix: "billing" },
  needs_reconnection: { text: "turn.error.needsReconnection", fix: "models" },
  org_deleting: { text: "turn.error.orgDeleting" },
};

interface TurnErrorState {
  text: string;
  retryable: boolean;
  requestId: string | undefined;
  action?: { label: string; href: string };
}

/** The sentence, plus the way out the reader's grants allow. */
function withFix(
  text: string,
  fix: keyof typeof FIX,
  t: ChatTranslate,
  can: ChatCan,
): Pick<TurnErrorState, "text" | "action"> {
  const { permission, label, href } = FIX[fix];
  return can(permission)
    ? { text, action: { label: t(label), href } }
    : { text: `${text} ${t("turn.error.contactAdmin")}` };
}

/**
 * A classified model failure as rendered. A dead credential is the one class
 * retrying cannot clear — so instead of a retry it names where it is fixed.
 */
function classifiedState(
  error: ClientTurnError,
  t: ChatTranslate,
  can: ChatCan,
): Pick<TurnErrorState, "text" | "action"> {
  const text = t(TURN_ERROR_KEY[error.category]);
  return error.category === "credential_unavailable" ? withFix(text, "models", t, can) : { text };
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
  can: ChatCan,
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
    // `errorCategory` is OPTIONAL on the persisted shape — it is stamped only
    // on a turn that carried an error, so the type forces a default here and
    // the compiler rejects the bare index. Not a legacy accommodation: the
    // `"deadline"` disjunct above has already proved it present, but a
    // disjunction narrows nothing, and the metadata is read back out of
    // unvalidated JSONB either way.
    const category = turn.errorCategory ?? "unknown";
    // Retry is a property of the CAUSE, not of the ceiling: a deadline turn
    // whose cause was rate limiting is retryable, one whose credential is
    // dead is not. Read the persisted verdict either way.
    const retryable = turn.errorRetryable !== false;
    return {
      ...classifiedState({ category, retryable }, t, can),
      retryable,
      requestId: turn.requestId,
    };
  }

  if (message.status?.type === "incomplete" && message.status.reason === "error") {
    const err = message.status.error;
    // An in-stream failure carries our marker; a turn refused BEFORE the stream
    // opened carries the RFC 9457 body the transport throws verbatim, whose
    // `code` we localize here. A refusal names an action the user must take, so
    // retrying cannot clear it.
    const classified = clientTurnErrorFromMarker(err) ?? clientTurnErrorFromRateLimit(err);
    // The marker carries the turn's request id; a refused request carries its
    // own in the problem document.
    const requestId = classified?.requestId ?? problemRequestId(err);
    if (classified) {
      return { ...classifiedState(classified, t, can), retryable: classified.retryable, requestId };
    }
    const code = refusalCode(err);
    const refusal =
      code && Object.prototype.hasOwnProperty.call(REFUSAL, code) ? REFUSAL[code] : undefined;
    if (!refusal) {
      return { text: t("turn.error.unknown"), retryable: true, requestId };
    }
    return {
      ...(refusal.fix ? withFix(t(refusal.text), refusal.fix, t, can) : { text: t(refusal.text) }),
      retryable: false,
      requestId,
    };
  }

  return null;
}
