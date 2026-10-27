// SPDX-License-Identifier: Apache-2.0

import { ApiError } from "../api/errors";

// `no_published_version` is also a run-launch refusal; here the remedy is to publish before
// enforcing. Every other refusal is named by its code via `errorMessage`.
const CHAT_ENFORCE_ERROR_KEYS: Readonly<Record<string, string>> = {
  no_published_version: "library.chatEnforce.error.noPublishedVersion",
};

/** The translation key for a refusal, or `undefined` when it has none of its own. */
export function chatEnforceErrorKey(err: unknown): string | undefined {
  return err instanceof ApiError ? CHAT_ENFORCE_ERROR_KEYS[err.code] : undefined;
}
