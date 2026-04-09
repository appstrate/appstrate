// SPDX-License-Identifier: Apache-2.0

/**
 * Agnostic hook helpers for the module system.
 *
 * These functions call named hooks/events on whatever module provides them.
 * The platform never knows which module implements a hook — it just
 * calls it by name. If no module provides the hook, it's a no-op.
 *
 * - Hooks (callHook/getHookValue): first-match-wins, for request/response patterns
 * - Events (emitEvent): broadcast-to-all, for notification patterns
 */

import { callHook, getHookValue, emitEvent } from "./module-loader.ts";

/** Check quota before a run. No-op if no module provides this hook. */
export async function checkQuota(orgId: string, runningRunCount: number): Promise<void> {
  await callHook("checkQuota", orgId, runningRunCount);
}

/** Record usage after a run. No-op if no module provides this hook. */
export async function recordUsage(
  orgId: string,
  runId: string,
  cost: number,
  context: { modelSource: string },
): Promise<Record<string, unknown> | undefined> {
  return callHook<Record<string, unknown>>("recordUsage", orgId, runId, cost, context);
}

/** Returns the QuotaExceededError constructor, or null if not provided. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getQuotaExceededError(): (new (...args: any[]) => Error) | null {
  return getHookValue("getQuotaExceededError");
}

/** Notify ALL modules of org creation. Uses event broadcasting. */
export async function onOrgCreated(orgId: string, userEmail: string): Promise<void> {
  await emitEvent("onOrgCreated", orgId, userEmail);
}

/** Notify ALL modules of org deletion. Uses event broadcasting. */
export async function onOrgDeleted(orgId: string): Promise<void> {
  await emitEvent("onOrgDeleted", orgId);
}
