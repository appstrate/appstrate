// SPDX-License-Identifier: Apache-2.0

/**
 * Lifecycle hook helpers for the module system.
 *
 * These functions expose platform lifecycle points that modules can hook into.
 * The platform never knows what a module does inside a hook — it just provides
 * the extension point. If no module provides a hook, it's a no-op.
 *
 * Naming conventions:
 *   Hooks (first-match-wins):  beforeX, resolveX
 *   Events (broadcast-to-all): onX
 */

import { callHook, emitEvent } from "./module-loader.ts";
import type { BeforeRunParams, RunRejection, RunStatusChangeParams } from "@appstrate/core/module";

// Re-export for consumers that import from hooks.ts
export type { BeforeRunParams, RunRejection, RunStatusChangeParams };

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
 * Run status change event — broadcast on every run lifecycle transition.
 * Modules decide internally what to do (webhooks, usage recording, analytics, etc.).
 * Broadcast-to-all: errors in individual handlers are isolated.
 */
export async function onRunStatusChange(params: RunStatusChangeParams): Promise<void> {
  await emitEvent("onRunStatusChange", params);
}

// ---------------------------------------------------------------------------
// Organization lifecycle
// ---------------------------------------------------------------------------

/** Notify ALL modules of org creation. Uses event broadcasting. */
export async function onOrgCreate(orgId: string, userEmail: string): Promise<void> {
  await emitEvent("onOrgCreate", orgId, userEmail);
}

/** Notify ALL modules of org deletion. Uses event broadcasting. */
export async function onOrgDelete(orgId: string): Promise<void> {
  await emitEvent("onOrgDelete", orgId);
}
