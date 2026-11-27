// SPDX-License-Identifier: Apache-2.0

import { CREDENTIAL_DEATH_CAUSES } from "@appstrate/core/sidecar-types";

/** The death record a dead credential carries on the wire; a leaf module so no spec file cycles. */
export const NEEDS_RECONNECTION_RECORD_PROPERTIES = {
  needs_reconnection_cause: {
    type: ["string", "null"],
    enum: [...CREDENTIAL_DEATH_CAUSES, null],
    description:
      "Why the credential died: set with `needs_reconnection` and cleared with it. `null` while healthy, and on a credential flagged before the cause was recorded.",
  },
  needs_reconnection_at: {
    type: ["string", "null"],
    format: "date-time",
    description:
      "When the credential died (RFC 3339). `null` under the same conditions as `needs_reconnection_cause`.",
  },
} as const;
