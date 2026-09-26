// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

/**
 * The refusals of `PATCH …/packages/{scope}/{name}` with `chat_enforced` that
 * the library can meet, by problem `code`, each naming what the reader can do.
 * The others (a non-skill, an unplaced row) are unreachable from a box drawn
 * on placed skill rows only, and keep the server's own message.
 */
const CHAT_ENFORCE_ERROR_KEYS: Readonly<Record<string, string>> = {
  no_published_version: "library.chatEnforce.error.noPublishedVersion",
  enforced_skills_limit: "library.chatEnforce.error.limit",
  enforced_skills_budget: "library.chatEnforce.error.budget",
};

/** The translation key for a refusal, or `undefined` when it has none of its own. */
export function chatEnforceErrorKey(err: unknown): string | undefined {
  return err instanceof ApiError ? CHAT_ENFORCE_ERROR_KEYS[err.code] : undefined;
}
