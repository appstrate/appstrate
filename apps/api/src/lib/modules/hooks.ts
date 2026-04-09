// SPDX-License-Identifier: Apache-2.0

/**
 * Typed hook helpers for cloud module.
 * Replace scattered `getCloudModule()?.cloudHooks.X()` calls with
 * null-safe, type-safe functions. All are no-ops when cloud is absent.
 */

import { getModule } from "./module-loader.ts";

/** Check billing quota. No-op if cloud module is not loaded. */
export async function checkQuota(orgId: string, runningRunCount: number): Promise<void> {
  const cloud = getModule("cloud");
  if (!cloud?.hooks?.checkQuota) return;
  await cloud.hooks.checkQuota(orgId, runningRunCount);
}

/** Record usage after a run. No-op if cloud module is not loaded. */
export async function recordUsage(
  orgId: string,
  runId: string,
  cost: number,
  context: { modelSource: string },
): Promise<Record<string, unknown> | undefined> {
  const cloud = getModule("cloud");
  if (!cloud?.hooks?.recordUsage) return undefined;
  return cloud.hooks.recordUsage(orgId, runId, cost, context);
}

/** Returns the QuotaExceededError constructor, or null if cloud is absent. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getQuotaExceededError(): (new (...args: any[]) => Error) | null {
  const cloud = getModule("cloud");
  if (!cloud?.hooks?.getQuotaExceededError) return null;
  return cloud.hooks.getQuotaExceededError();
}

/** Notify cloud of org creation. No-op if cloud not loaded. */
export async function onOrgCreated(orgId: string, userEmail: string): Promise<void> {
  const cloud = getModule("cloud");
  if (!cloud?.hooks?.onOrgCreated) return;
  await cloud.hooks.onOrgCreated(orgId, userEmail);
}

/** Notify cloud of org deletion. No-op if cloud not loaded. */
export async function onOrgDeleted(orgId: string): Promise<void> {
  const cloud = getModule("cloud");
  if (!cloud?.hooks?.onOrgDeleted) return;
  await cloud.hooks.onOrgDeleted(orgId);
}
