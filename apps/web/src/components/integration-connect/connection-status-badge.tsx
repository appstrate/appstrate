// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";

/**
 * Health states a connection pill can express. `needsReconnection` is a
 * RECOVERABLE warning (the owner can renew) — it must read as amber, never
 * red/destructive, on every surface.
 */
export type ConnectionStatusTone = "connected" | "needsReconnection" | "missingScopes";

const TONE_CLASSES: Record<ConnectionStatusTone, string> = {
  connected: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  needsReconnection: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  missingScopes: "border-destructive/40 bg-destructive/10 text-destructive",
};

/**
 * Connection-state pill shared across every surface that flags a connection's
 * health — the member connections page and the integration detail page (the
 * Connexions picker keeps its own dropdown-row affordances). Owns the
 * tone→color mapping so the same state can never render red on one surface and
 * amber on another: `needs_reconnection` was previously a destructive (red)
 * badge on the integration detail page but an amber pill in preferences.
 *
 * Text stays a child so each call site keeps its own i18n key/namespace.
 */
export function ConnectionStatusBadge({
  tone,
  children,
}: {
  tone: ConnectionStatusTone;
  children: ReactNode;
}) {
  return (
    <span className={`rounded-full border px-2 py-px text-[0.65rem] ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}
