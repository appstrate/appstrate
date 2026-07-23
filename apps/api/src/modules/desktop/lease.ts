// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Process-local exclusive ownership of a user's desktop browser.
 *
 * The bridge registry is process-local, so the matching lease belongs
 * beside it. One run may drive a user's single browser surface at a
 * time. A terminal run event releases ownership immediately; the idle
 * expiry is only a crash fallback.
 */

const IDLE_TTL_MS = 5 * 60 * 1000;
const HISTORY_TTL_MS = 6 * 60 * 60 * 1000;

interface Lease {
  runId: string;
  touchedAt: number;
  usedCredentialSubstitution: boolean;
  usedArbitraryEvaluate: boolean;
}

interface PreviousOwner {
  runId: string;
  touchedAt: number;
}

const leasesByUser = new Map<string, Lease>();
const previousOwnerByUser = new Map<string, PreviousOwner>();

export class DesktopLeaseConflictError extends Error {
  constructor(readonly activeRunId: string) {
    super("This desktop browser is already controlled by another active run");
    this.name = "DesktopLeaseConflictError";
  }
}

export class DesktopExposureConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DesktopExposureConflictError";
  }
}

function sweep(now: number): void {
  for (const [userId, lease] of leasesByUser) {
    if (now - lease.touchedAt <= IDLE_TTL_MS) continue;
    leasesByUser.delete(userId);
    previousOwnerByUser.set(userId, { runId: lease.runId, touchedAt: now });
  }
  for (const [userId, previous] of previousOwnerByUser) {
    if (now - previous.touchedAt > HISTORY_TTL_MS) previousOwnerByUser.delete(userId);
  }
}

/**
 * Acquire or refresh a run's lease. `requiresReset` tells the route to
 * blank the renderer before handing it from one run to another.
 */
export function acquireDesktopLease(userId: string, runId: string): { requiresReset: boolean } {
  const now = Date.now();
  sweep(now);
  const current = leasesByUser.get(userId);
  if (current) {
    if (current.runId !== runId) throw new DesktopLeaseConflictError(current.runId);
    current.touchedAt = now;
    return { requiresReset: false };
  }

  const previous = previousOwnerByUser.get(userId);
  leasesByUser.set(userId, {
    runId,
    touchedAt: now,
    usedCredentialSubstitution: false,
    usedArbitraryEvaluate: false,
  });
  return { requiresReset: previous !== undefined && previous.runId !== runId };
}

/**
 * Do not let arbitrary page JavaScript and platform-substituted secrets
 * share a run. Exact-value reply scrubbing cannot catch transformed
 * values, so either ordering is rejected.
 */
export function recordDesktopExposure(
  userId: string,
  runId: string,
  exposure: "credential_substitution" | "arbitrary_evaluate",
): void {
  const lease = leasesByUser.get(userId);
  if (!lease || lease.runId !== runId) {
    throw new DesktopLeaseConflictError(lease?.runId ?? "unknown");
  }
  lease.touchedAt = Date.now();
  if (exposure === "credential_substitution") {
    if (lease.usedArbitraryEvaluate) {
      throw new DesktopExposureConflictError(
        "Credential substitution is unavailable after browser.evaluate in the same run",
      );
    }
    lease.usedCredentialSubstitution = true;
    return;
  }
  if (lease.usedCredentialSubstitution) {
    throw new DesktopExposureConflictError(
      "browser.evaluate is unavailable after credential substitution in the same run",
    );
  }
  lease.usedArbitraryEvaluate = true;
}

export function releaseDesktopLease(userId: string, runId: string): void {
  const lease = leasesByUser.get(userId);
  if (!lease || lease.runId !== runId) return;
  leasesByUser.delete(userId);
  previousOwnerByUser.set(userId, { runId, touchedAt: Date.now() });
}

export function releaseDesktopLeaseByRun(runId: string): string[] {
  const releasedUserIds: string[] = [];
  for (const [userId, lease] of leasesByUser) {
    if (lease.runId !== runId) continue;
    releaseDesktopLease(userId, runId);
    releasedUserIds.push(userId);
  }
  return releasedUserIds;
}

/** Test and shutdown helper. */
export function clearDesktopLeases(): void {
  leasesByUser.clear();
  previousOwnerByUser.clear();
}
