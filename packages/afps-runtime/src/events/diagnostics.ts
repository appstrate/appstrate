// SPDX-License-Identifier: Apache-2.0

import type { RunEvent } from "@afps-spec/types";
import { parseTokenUsage } from "@appstrate/afps-shared/token-usage";

/** Read only the diagnostic events Appstrate owns. The raw AFPS stream remains extensible. */
export function readRunDiagnostic(event: RunEvent) {
  switch (event.type) {
    case "appstrate.progress":
    case "appstrate.error": {
      const message = typeof event.message === "string" ? event.message : null;
      const data =
        event.data !== null && typeof event.data === "object" && !Array.isArray(event.data)
          ? (event.data as Record<string, unknown>)
          : null;
      if (event.type === "appstrate.error") return { type: event.type, message, data } as const;
      const level = event.level;
      return {
        type: event.type,
        message,
        data,
        level: level === "info" || level === "warn" || level === "error" ? level : "debug",
      } as const;
    }
    case "appstrate.metric": {
      const { usage, tiersDropped } = parseTokenUsage(event.usage);
      return {
        type: event.type,
        usage,
        tiersDropped,
        invalidUsage: event.usage != null && !usage,
        cost: typeof event.cost === "number" && Number.isFinite(event.cost) ? event.cost : null,
      } as const;
    }
    default:
      return null;
  }
}
