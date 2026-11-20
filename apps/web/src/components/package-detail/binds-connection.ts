// SPDX-License-Identifier: Apache-2.0

import { isUnauthenticatedIntegration } from "@appstrate/core/integration";
import type { IntegrationDetailWire } from "../../hooks/use-integrations";

/**
 * Whether an integration has a row. On a schedule, the readiness entry judges the version it
 * fires; without one (loading, errored, disabled) fall back to the live manifest, as off a schedule.
 * `readiness` is `undefined` off a schedule.
 */
export function bindsConnection(
  detail: IntegrationDetailWire | undefined,
  readiness: { connection_required: boolean } | undefined,
): boolean {
  return readiness
    ? readiness.connection_required !== false
    : !(detail && isUnauthenticatedIntegration(detail.manifest));
}
