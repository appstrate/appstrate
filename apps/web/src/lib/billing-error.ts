// SPDX-License-Identifier: Apache-2.0

import { getErrorMessage } from "@appstrate/core/errors";

/**
 * What a refused billing save reaches the operator as. Both admin sections hand
 * `toast.error` this, so the server's problem+json `detail` — the sentence that
 * names the offending id or field — cannot degrade to "API Error: 400" in one
 * of them only. `prefix` is the caller's `t("error.prefix", …)`.
 */
export function billingSaveErrorMessage(
  error: unknown,
  prefix: (message: string) => string,
): string {
  return prefix(getErrorMessage(error));
}
