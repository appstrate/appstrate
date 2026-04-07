// SPDX-License-Identifier: Apache-2.0

import type { AvailableScope } from "@appstrate/core/validation";

/**
 * Resolve a scope value to its human-readable label using the provider's
 * availableScopes mapping. Returns the raw value as fallback.
 */
export function resolveScopeLabel(scope: string, availableScopes?: AvailableScope[]): string {
  if (!availableScopes) return scope;
  const match = availableScopes.find((s) => s.value === scope);
  return match?.label ?? scope;
}
