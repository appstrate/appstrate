// SPDX-License-Identifier: Apache-2.0

import type { TestResult } from "@appstrate/shared-types";
import { sentenceKey } from "./mutation-error";

/**
 * `settings` sentences for the failure codes of a model's connection test. The
 * generic code table words `needs_reconnection` for an integration connection
 * and its owner; a model's credential is neither.
 */
export const MODEL_TEST_FAILURE_KEYS = {
  needs_reconnection: "models.credentialUnavailableHint",
} as const;

/** The surface's own sentence for a failed test, or `undefined` to fall back on the generic one. */
export function testFailureKey(
  result: Pick<TestResult, "ok" | "error">,
  failureKeys: Readonly<Record<string, string>> | undefined,
): string | undefined {
  if (result.ok || !result.error || !failureKeys) return undefined;
  return sentenceKey(failureKeys, result.error.toLowerCase());
}
