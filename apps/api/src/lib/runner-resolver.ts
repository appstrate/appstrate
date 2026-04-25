// SPDX-License-Identifier: Apache-2.0

/**
 * Runtime registry for module-contributed runner-name resolvers.
 *
 * Mirrors the `setModulePermissionsProvider` pattern: core defines the
 * extension point + null fallback, modules register at init() time, and
 * `lib/runner-context.ts` consults the registry without owning any
 * module-specific knowledge. When OIDC is not loaded the registry stays
 * empty and the JWT-based lookup branch silently no-ops — falling back
 * to whatever the request headers carried.
 */

export interface RunnerResolverContext {
  /** Stamped by the OIDC strategy on `c.var.authExtra.cliFamilyId`. */
  cliFamilyId: string | null;
}

export interface RunnerResolverResult {
  /** Human-friendly device label (`cli_refresh_tokens.device_name`, …). */
  name: string | null;
  /** Forced kind override (`"cli"` for CLI tokens). Optional. */
  kind?: string | null;
}

export type RunnerResolver = (ctx: RunnerResolverContext) => Promise<RunnerResolverResult | null>;

let _resolver: RunnerResolver | null = null;

export function setRunnerResolver(resolver: RunnerResolver | null): void {
  _resolver = resolver;
}

export function getRunnerResolver(): RunnerResolver | null {
  return _resolver;
}
