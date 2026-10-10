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
import {
  turnMetadataFromMessage,
  type AppstrateTurnMetadata,
} from "@appstrate/core/chat-turn-metadata";

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
 * Where an administrator fixes a failure. The link needs EVERY permission: the
 * fix's and the page's. Plain paths: the module never imports the router.
 */
const FIX = {
  billing: {
    permissions: ["billing:manage"],
    label: "turn.error.manageBilling",
    href: "/org-settings/billing",
  },
  models: {
    permissions: ["model-provider-credentials:write", "models:read"],
    label: "turn.error.manageModels",
    href: "/org-settings/models",
  },
  personalModels: {
    permissions: ["model-provider-credentials:connect"],
    label: "turn.error.managePersonalModels",
    href: "/preferences/models",
  },
} as const;

/**
 * `memberText`: the whole sentence for a reader who cannot apply the fix `text` asks for.
 * `policyDisabledText`: the whole sentence when the organization refuses personal
 * credentials, which withdraws the `personalModels` fix altogether.
 */
interface Fixable {
  text: string;
  memberText?: string;
  policyDisabledText?: string;
  fix: keyof typeof FIX;
}

const DEAD_CREDENTIAL: Fixable = {
  text: "turn.error.credentialUnavailable",
  memberText: "turn.error.credentialUnavailableMember",
  fix: "models",
};

/**
 * Sentences for the refusals a turn can be denied with BEFORE the stream opens.
 * A refused turn is not a model failure — "check the model configuration" would
 * send the user to the wrong screen — so each code gets its own copy. Keyed by
 * the wire code, loosely: a code we have no sentence for degrades to the
 * generic failure rather than rendering a missing i18n key.
 */
const REFUSAL: Record<string, Fixable | { text: string; fix?: undefined }> = {
  quota_exceeded: { text: "turn.error.quotaExceeded", fix: "billing" },
  subscription_blocked: { text: "turn.error.subscriptionBlocked", fix: "billing" },
  // Raised for a dead subscription, which is always its holder's own.
  needs_reconnection: { text: "turn.error.needsReconnection", fix: "personalModels" },
  org_deleting: { text: "turn.error.orgDeleting" },
  model_credential_required: {
    text: "turn.error.modelCredentialRequired",
    policyDisabledText: "turn.error.modelCredentialRequiredPolicy",
    fix: "personalModels",
  },
};

interface TurnErrorState {
  text: string;
  retryable: boolean;
  requestId: string | undefined;
  action?: { label: string; href: string };
}

function withFix(
  { text, memberText, policyDisabledText, fix }: Fixable,
  t: ChatTranslate,
  can: ChatCan,
  personalModelCredentials: boolean,
): Pick<TurnErrorState, "text" | "action"> {
  const { permissions, label, href } = FIX[fix];
  // A personal credential cannot be added while the organization refuses them:
  // the link would lead to a form answering 403, so only the sentence is shown.
  if (fix === "personalModels" && !personalModelCredentials)
    return {
      text: policyDisabledText
        ? t(policyDisabledText)
        : `${t(text)} ${t("turn.error.contactAdmin")}`,
    };
  if (permissions.every((permission) => can(permission)))
    return { text: t(text), action: { label: t(label), href } };
  return { text: memberText ? t(memberText) : `${t(text)} ${t("turn.error.contactAdmin")}` };
}

/** A dead credential cannot be retried: it names where it is fixed instead. */
function classifiedState(
  category: ClientTurnError["category"],
  t: ChatTranslate,
  can: ChatCan,
  personalModelCredentials: boolean,
): Pick<TurnErrorState, "text" | "action"> {
  return category === "credential_unavailable"
    ? withFix(DEAD_CREDENTIAL, t, can, personalModelCredentials)
    : { text: t(TURN_ERROR_KEY[category]) };
}

/** Errored outright, or cut by the deadline while failing (see `turnErrorState`). */
export function turnFailed(turn: AppstrateTurnMetadata | null): turn is AppstrateTurnMetadata {
  return (
    turn?.finishReason === "error" ||
    (turn?.finishReason === "deadline" && turn.errorCategory !== undefined)
  );
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
  // Whether the organization lets members bring personal model credentials
  // (`personal_model_credentials`); absent means allowed, as on the server.
  personalModelCredentials = true,
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
  if (turnFailed(turn)) {
    return {
      // Optional on the persisted shape (unvalidated JSONB): default it.
      ...classifiedState(turn.errorCategory ?? "unknown", t, can, personalModelCredentials),
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
    const classified = clientTurnErrorFromMarker(err) ?? clientTurnErrorFromRateLimit(err);
    const requestId = classified?.requestId ?? problemRequestId(err);
    if (classified) {
      return {
        ...classifiedState(classified.category, t, can, personalModelCredentials),
        retryable: classified.retryable,
        requestId,
      };
    }
    const code = refusalCode(err);
    const refusal =
      code && Object.prototype.hasOwnProperty.call(REFUSAL, code) ? REFUSAL[code] : undefined;
    if (!refusal) {
      return { text: t("turn.error.unknown"), retryable: true, requestId };
    }
    return {
      ...(refusal.fix
        ? withFix(refusal, t, can, personalModelCredentials)
        : { text: t(refusal.text) }),
      retryable: false,
      requestId,
    };
  }

  return null;
}
