// SPDX-License-Identifier: Apache-2.0

/**
 * Test double for the platform `PlatformServices` handle the billing module captures at
 * `init`. The billing module's only platform reads are the append-only `llm_usage` ledger
 * cursor — `usage.list({ afterId, limit, credentialSource })` and
 * `usage.settledFrontier()`. Billing tests drive it by seeding `mockLedger` (an
 * id-ordered array of `LlmUsageLedgerRow`s) instead of inserting into the
 * platform-owned `llm_usage` table (which no longer lives in the billing module's DB).
 */

import type { Context } from "hono";
import type { LlmUsageLedgerRow, PlatformServices, TerminalRunRow } from "@appstrate/core/module";

/** Ordered ledger rows the platform would return, ascending by `id`. */
export const mockLedger: LlmUsageLedgerRow[] = [];

/**
 * Finished runs the platform would return from `runs.listTerminal`. Tests push rows (see
 * `seedTerminalRun`) instead of inserting into the platform-owned `runs` table.
 */
export const mockRuns: TerminalRunRow[] = [];

/** Set when the next `runs.listTerminal` read should throw. */
let mockRunsError = false;

export function resetMockRuns(): void {
  mockRuns.length = 0;
  mockRunsError = false;
}

let mockRunsGate: Promise<void> | null = null;
let releaseRunsGate: (() => void) | null = null;

/** Make `runs.listTerminal` wait until {@link releaseMockRunsHang} — drives a wedged pass. */
export function setMockRunsHang(): void {
  mockRunsGate = new Promise<void>((resolve) => {
    releaseRunsGate = resolve;
  });
}

export function releaseMockRunsHang(): void {
  releaseRunsGate?.();
  mockRunsGate = null;
  releaseRunsGate = null;
}

/** Make the next `runs.listTerminal` read throw — drives settlement failure paths. */
export function setMockRunsError(): void {
  mockRunsError = true;
}

/** Set when the next ledger read should throw (simulate a platform/DB blip). */
let mockLedgerError = false;

/**
 * Runs inside `usage.list`, after `afterId` has been captured by the sweep but
 * before its transaction commits. Lets a test simulate a concurrent sweeper
 * mutating billing state (e.g. advancing the watermark) mid-pass.
 */
let mockListHook: (() => void | Promise<void>) | null = null;

export function resetMockLedger(): void {
  mockLedger.length = 0;
  mockLedgerError = false;
  mockListHook = null;
}

/** Make the next `usage.list` read throw — drives sweep failure paths. */
export function setMockLedgerError(): void {
  mockLedgerError = true;
}

/** Register a side effect to run during the next `usage.list` call(s). */
export function setMockLedgerListHook(fn: (() => void | Promise<void>) | null): void {
  mockListHook = fn;
}

/**
 * Recorded `setFileStorageLimit` calls — the storage-entitlement sync's only
 * platform write. Tests assert on this instead of a platform DB.
 *
 * The member name matters more than it looks: `mockPlatformServices` is cast
 * `as unknown as PlatformServices`, so a double whose member no longer matches the one
 * the code calls still typechecks and every assertion here quietly sees zero calls.
 * Check the name against `PlatformServices` when this file stops catching a regression.
 */
export const mockStorageLimitCalls: Array<{ orgId: string; bytes: number | null }> = [];

/** Set when the next `setFileStorageLimit` call should throw. */
let mockStorageLimitError = false;

/**
 * Runs inside `setFileStorageLimit`, before the call is recorded. Lets a
 * test simulate a concurrent plan transition (e.g. a Stripe webhook) landing
 * while an entitlement write is in flight — the stale-write interleaving.
 */
let mockStorageLimitHook: (() => void | Promise<void>) | null = null;

export function resetMockStorageLimits(): void {
  mockStorageLimitCalls.length = 0;
  mockStorageLimitError = false;
  mockStorageLimitHook = null;
}

/** Make the next `setFileStorageLimit` call throw (platform write failure). */
export function setMockStorageLimitError(): void {
  mockStorageLimitError = true;
}

/** Register a side effect to run during the next `setFileStorageLimit` call(s). */
export function setMockStorageLimitHook(fn: (() => void | Promise<void>) | null): void {
  mockStorageLimitHook = fn;
}

/** Recorded `audit.record` entries, with the org the request context carried. */
export const mockAuditEntries: Array<{
  orgId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  after?: Record<string, unknown> | null;
}> = [];

export function resetMockAudit(): void {
  mockAuditEntries.length = 0;
}

export const mockPlatformServices = {
  audit: {
    record: async (
      c: Context,
      entry: Omit<(typeof mockAuditEntries)[number], "orgId">,
    ): Promise<void> => {
      mockAuditEntries.push({ orgId: c.get("orgId"), ...entry });
    },
  },
  usage: {
    list: async ({
      afterId = 0,
      limit = 500,
      credentialSource,
    }: {
      afterId?: number;
      limit?: number;
      credentialSource?: "system" | "org";
    }): Promise<LlmUsageLedgerRow[]> => {
      if (mockLedgerError) {
        mockLedgerError = false;
        throw new Error("mock ledger read failure");
      }
      if (mockListHook) await mockListHook();
      return mockLedger
        .filter((r) => r.id > afterId)
        .filter((r) => credentialSource === undefined || r.credentialSource === credentialSource)
        .sort((a, b) => a.id - b.id)
        .slice(0, limit);
    },
    settledFrontier: async (): Promise<number> => {
      // Highest id N such that every row with id <= N is settled:
      // MIN(unsettled id) - 1 when any unsettled row exists, else MAX(id), else 0.
      if (mockLedger.length === 0) return 0;
      const unsettled = mockLedger.filter((r) => !r.settled).map((r) => r.id);
      if (unsettled.length > 0) return Math.min(...unsettled) - 1;
      return Math.max(...mockLedger.map((r) => r.id));
    },
  },
  runs: {
    listTerminal: async ({
      after,
      limit = 500,
    }: {
      after?: { completedAt: Date; id: string };
      limit?: number;
    }): Promise<TerminalRunRow[]> => {
      if (mockRunsGate) await mockRunsGate;
      if (mockRunsError) {
        mockRunsError = false;
        throw new Error("mock runs read failure");
      }
      const ordered = [...mockRuns].sort(
        (a, b) => a.completedAt.getTime() - b.completedAt.getTime() || a.id.localeCompare(b.id),
      );
      return ordered
        .filter(
          (r) =>
            !after ||
            r.completedAt.getTime() > after.completedAt.getTime() ||
            (r.completedAt.getTime() === after.completedAt.getTime() && r.id > after.id),
        )
        .slice(0, limit);
    },
  },
  setFileStorageLimit: async (orgId: string, bytes: number | null): Promise<void> => {
    if (mockStorageLimitError) {
      mockStorageLimitError = false;
      throw new Error("mock storage limit write failure");
    }
    if (mockStorageLimitHook) await mockStorageLimitHook();
    mockStorageLimitCalls.push({ orgId, bytes });
  },
} as unknown as PlatformServices;
