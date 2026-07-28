// SPDX-License-Identifier: Apache-2.0

/**
 * Pure-types module for the run-sink context populated by the
 * `verifyRunSignature` middleware.
 *
 * Split out from `services/run-event-ingestion.ts` so that
 * `types/index.ts` can reference the shape without pulling in the
 * service's runtime imports (which transitively touch
 * `@appstrate/connect` and `@appstrate/afps-runtime/resolvers`).
 * Web-side TypeScript consumers that import `AppEnv` therefore don't
 * accidentally compile the resolver/fetch-heavy modules.
 */

// Type-only (erased at emit), so the "no runtime imports" rule above holds.
import type { ModelCost } from "@appstrate/core/module";

/**
 * Narrow projection of the `runs` row used for signature verification +
 * event dispatch on `POST /api/runs/:runId/events`.
 */
export interface RunSinkContext {
  id: string;
  orgId: string;
  applicationId: string;
  packageId: string;
  runOrigin: "platform" | "remote";
  sinkSecretEncrypted: string;
  sinkExpiresAt: Date | null;
  sinkClosedAt: Date | null;
  lastEventSequence: number;
  startedAt: Date;
  /**
   * The agent definition the run executes — `"draft"` or a concrete semver
   * stamped at kickoff (#636). Finalize reads the output schema from the
   * manifest AT this ref (`getRunEffectiveAgent`) so a post-kickoff draft
   * edit cannot change a pinned run's output contract.
   */
  versionRef: string;
  /**
   * Model source resolved at run creation time (`"system"` for platform-paid
   * models, `"org"` for BYOK). Forwarded to the `onRunStatusChange` event so
   * module listeners can distinguish billable from non-billable runs.
   */
  modelSource: string | null;
  /**
   * Per-1M-token rates snapshotted at kickoff (`runs.model_cost`). The runner
   * reports its own cost, so this is the only platform-side fact from which its
   * ledger row's `pricing_status` can be derived. `null` = the run resolved no
   * pricing (or, for a remote-origin run, no platform model at all).
   */
  modelCost: ModelCost | null;
}
