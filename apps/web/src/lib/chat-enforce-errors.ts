// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

/**
 * The one refusal of `PATCH …/packages/{scope}/{name}` with `chat_enforced` whose sentence
 * depends on WHERE it is met: `no_published_version` is also a run-launch refusal, and here the
 * remedy is to publish before enforcing. Every other refusal (the limit, the budget, a
 * non-skill) is named by its code like anywhere else — `errorMessage`.
 */
const CHAT_ENFORCE_ERROR_KEYS: Readonly<Record<string, string>> = {
  no_published_version: "library.chatEnforce.error.noPublishedVersion",
};

/** The translation key for a refusal, or `undefined` when it has none of its own. */
export function chatEnforceErrorKey(err: unknown): string | undefined {
  return err instanceof ApiError ? CHAT_ENFORCE_ERROR_KEYS[err.code] : undefined;
}
