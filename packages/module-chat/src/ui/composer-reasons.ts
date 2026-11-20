// SPDX-License-Identifier: Apache-2.0

/** Why the space limit is offered but inert: the key of the sentence that says it. */

import type { LimitUnavailableReason } from "./conversation-scope.ts";

export const LIMIT_REASON_KEY: Record<LimitUnavailableReason, string> = {
  generating: "composer.limit.generating",
  "no-acting-space": "composer.limit.noActingSpace",
  outside: "composer.limit.outside",
};
