// SPDX-License-Identifier: Apache-2.0

import { resolveRunTimeout } from "./run-limits.ts";

/**
 * Install-time warnings for `agent` manifests that declare something the
 * platform will silently narrow at run time.
 *
 * Sibling of `integration-install-warnings.ts` (same non-blocking `warnings`
 * channel on the import 201) but kept separate for two reasons: the rules here
 * are agent-only — a skill / mcp-server / integration has no run timeout — and,
 * unlike those collectors, this one is NOT pure: it reads the platform run
 * limits registry, so it inherits the "not initialized ⇒ throw" contract of
 * `getPlatformRunLimits()`.
 *
 * Today: the `timeout` ceiling. `runPreflightGates` clamps a declared timeout
 * to `PLATFORM_RUN_LIMITS.timeout_ceiling_seconds` before the run starts, which
 * is correct but invisible — an author who declares 10800 gets 1800 with no
 * signal short of watching a run die at the wrong moment. Warning at import
 * time is the earliest point the platform actually holds the manifest.
 *
 * Deliberately a warning, never a rejection: the ceiling is deployment-specific
 * (self-hosters raise it), so a manifest declaring above THIS deployment's
 * ceiling is portable and valid — rejecting it would make a package
 * un-importable on the smaller of two instances that both run it fine.
 */
export function collectAgentTimeoutWarnings(manifest: unknown): string[] {
  if (typeof manifest !== "object" || manifest === null) return [];
  const m = manifest as Record<string, unknown>;
  if (m.type !== "agent") return [];

  const { declaredSeconds, effectiveSeconds, capped } = resolveRunTimeout(m.timeout);
  if (!capped) return [];

  return [
    `timeout: declared ${declaredSeconds}s exceeds this deployment's ceiling — runs will be capped at ${effectiveSeconds}s.`,
  ];
}
