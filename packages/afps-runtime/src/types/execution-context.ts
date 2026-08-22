// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Appstrate

/**
 * Execution Context — the runtime state passed to an AFPS runner at boot.
 *
 * Contains everything that varies between runs (input, prior memories,
 * pinned slots, previous checkpoint, run history). MUST NOT contain
 * authentication material or infrastructure wiring: the HMAC
 * secret used to sign events, sink URLs, API keys, and OAuth tokens all
 * travel through separate channels (env variables, secret files) so that
 * exporting a `context.json` for debug or replay never leaks a usable
 * credential.
 *
 * Specification: see `AFPS_EXTENSION_ARCHITECTURE.md` §3 constraint 3, §7.
 */

import { z } from "zod";

const memorySnapshotSchema = z.object({
  content: z.string(),
  createdAt: z.number(),
});

const historyEntrySchema = z.object({
  runId: z.string(),
  timestamp: z.number(),
  output: z.unknown(),
});

/**
 * Zod schema for {@link ExecutionContext}. Use {@link executionContextSchema.safeParse}
 * to validate untrusted input (e.g. a `context.json` file) before the
 * runtime consumes it.
 */
export const executionContextSchema = z.object({
  // Required
  runId: z.string().min(1),
  input: z.unknown(),

  // Optional — absence means the corresponding feature is naturally inactive.
  // See AFPS_EXTENSION_ARCHITECTURE.md §3.2 "pure template / impure context".
  memories: z.array(memorySnapshotSchema).optional(),
  checkpoint: z.unknown().optional(),
  /**
   * Named pinned slots written via `pin({ key, content })` with any key
   * other than `"checkpoint"`. Each entry is last-write-wins per `(scope, key)`
   * after upstream visibility filtering. Surfaced in the prompt's
   * `## Pinned Slots` section. The `"checkpoint"` slot is intentionally
   * excluded — it is rendered separately as `## Checkpoint`.
   */
  pinnedSlots: z.record(z.string(), z.unknown()).optional(),
  history: z.array(historyEntrySchema).optional(),

  traceparent: z.string().optional(), // W3C Trace Context

  /**
   * Wall-clock execution budget for the run, in seconds. When set, the
   * runner arms its OWN timeout watchdog measured from the moment
   * `run()` starts — so container cold-start / boot is deliberately
   * EXCLUDED from the budget (the platform arms a separate, longer safety
   * net that folds in boot). On expiry the runner finalizes a `timeout`
   * terminal with an explicit `Run timed out after Ns` message, rather
   * than letting the platform kill the container and surface a generic
   * abort. Absent ⇒ no runner-side enforcement (platform safety net only).
   */
  timeoutSeconds: z.number().positive().optional(),
});

export type ExecutionContext = z.infer<typeof executionContextSchema>;

export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>;
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

/**
 * Seedable snapshot file accepted by `afps render --snapshot` and
 * `appstrate run --snapshot`: the subset of {@link ExecutionContext} a
 * caller may pre-seed (prior memories / conversation history / persisted
 * checkpoint). Extra keys are ignored by loaders so the format can evolve
 * without breaking fixtures.
 */
export interface SnapshotFile {
  memories?: ExecutionContext["memories"];
  history?: ExecutionContext["history"];
  checkpoint?: unknown;
}
