// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle hook helpers for the module system.
 *
 * These functions expose platform lifecycle points that modules can hook into.
 * The platform never knows what a module does inside a hook — it just provides
 * the extension point. If no module provides a hook, it's a no-op.
 *
 * Naming convention:
 * - beforeX / afterX → lifecycle hooks on platform operations
 * - onX              → lifecycle events (broadcast-to-all)
 */

import { callHook, emitEvent } from "./module-loader.ts";
import type { BeforeRunParams, RunRejection, AfterRunParams } from "@appstrate/core/module";

// Re-export for consumers that import from hooks.ts
export type { BeforeRunParams, RunRejection, AfterRunParams };

// ---------------------------------------------------------------------------
// Signup lifecycle
// ---------------------------------------------------------------------------

/**
 * Pre-signup hook — gives modules a chance to reject signup (e.g. domain allowlist).
 * Throws to reject. No-op if no module provides this hook.
 */
export async function beforeSignup(email: string): Promise<void> {
  await callHook("beforeSignup", email);
}

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

/**
 * Pre-run hook — gives modules a chance to block a run before execution.
 * Returns a structured rejection if a module blocks the run, or undefined if allowed.
 * No-op if no module provides this hook.
 */
export async function beforeRun(params: BeforeRunParams): Promise<RunRejection | null | undefined> {
  return callHook("beforeRun", params);
}

/**
 * Post-run event — notifies all modules that a run has completed.
 * Modules decide internally what to do (record usage, analytics, audit, etc.).
 * Broadcast-to-all: errors in individual handlers are isolated.
 */
export async function afterRun(params: AfterRunParams): Promise<void> {
  await emitEvent("afterRun", params);
}

// ---------------------------------------------------------------------------
// Organization lifecycle
// ---------------------------------------------------------------------------

/** Notify ALL modules of org creation. Uses event broadcasting. */
export async function onOrgCreated(orgId: string, userEmail: string): Promise<void> {
  await emitEvent("onOrgCreated", orgId, userEmail);
}

/** Notify ALL modules of org deletion. Uses event broadcasting. */
export async function onOrgDeleted(orgId: string): Promise<void> {
  await emitEvent("onOrgDeleted", orgId);
}
