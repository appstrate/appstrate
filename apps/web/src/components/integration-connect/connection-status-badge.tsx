// SPDX-License-Identifier: Apache-2.0

import type { ReactNode } from "react";
import { Badge, type BadgeProps } from "@appstrate/ui/components/badge";

/**
 * Health states a connection pill can express. `needsReconnection` is a
 * RECOVERABLE warning (the owner can renew) — it must read as amber, never
 * red/destructive, on every surface.
 */
type ConnectionStatusTone = "connected" | "needsReconnection" | "missingScopes";

const TONE_VARIANTS: Record<ConnectionStatusTone, BadgeProps["variant"]> = {
  connected: "success",
  needsReconnection: "warning",
  missingScopes: "failed",
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
  return <Badge variant={TONE_VARIANTS[tone]}>{children}</Badge>;
}
